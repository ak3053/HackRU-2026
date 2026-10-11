import asyncio
from datetime import datetime, timezone
from typing import Optional
import uuid

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
import laya
from pydantic import BaseModel, ConfigDict
from storage import get_incident, initialize_db, list_recent_incidents, save_incident, update_status



##########LAYA##############

print("Loading Laya model into memory... (This may take a minute)")
# The Router picks the checkpoint per message (English vs. multilingual).
# On first run, it will download the weights; subsequent runs will use cached files.
router = laya.Router()
router.preload(["english", "multilingual"])

print("Model loaded successfully!")

# Ordered lowest to highest: Laya scores a "score" question by the index of the level,
# so five levels give an urgency from 0 (trivial) to 4 (critical).
URGENCY_LEVELS = ["trivial", "minor", "moderate", "serious", "critical"]

questions = {
    "life_threat": {"type": "noul", "instructions": "Is anyone's life in danger?"},
    "urgency": {"type": "score", "instructions": "How urgent is this emergency?",
                "criteria": URGENCY_LEVELS},
}

# One independent yes/no question per category, so an SOS can belong to several at once
# (e.g. someone injured under a collapsed roof is both Medical and Trapped/Structural).
CATEGORY_QUESTIONS = {
    "Medical": "Is a person hurt or unwell?",
    "Fire": "Is something on fire?",
    "Trapped/Structural": "Has a structure collapsed, or is someone trapped?",
    "Supply/Ration": "Does someone need food, water, or other supplies?",
    "Flood": "Is this a flood?",
    "Natural Disaster": "Is this a natural disaster?",
}
questions.update({name: {"type": "noul", "instructions": ins} for name, ins in CATEGORY_QUESTIONS.items()})

LIFE_THREAT_THRESHOLD = 0.5
# Deliberately low: a false alarm costs a dispatcher a glance, a miss costs far more
CATEGORY_THRESHOLD = 0.2

# One inference at a time: the model is shared across requests
predict_lock = asyncio.Lock()


def triage(message: str) -> dict:
    answers = router.predict(message, questions)["answers"]

    life_threat = answers["life_threat"]["noul"]  # P(yes)
    # "score" is the probability-weighted level, a float in [0, 4]
    urgency_score = answers["urgency"]["score"]
    urgency = min(max(round(urgency_score), 0), len(URGENCY_LEVELS) - 1)

    # P(yes) per category, highest first
    category_scores = dict(sorted(((name, round(answers[name]["noul"], 2)) for name in CATEGORY_QUESTIONS),
                                  key=lambda item: item[1], reverse=True))
    top_category = next(iter(category_scores))

    return {
        "is_life_threatening": life_threat > LIFE_THREAT_THRESHOLD,
        "threat_confidence": round(life_threat, 2),
        "category": top_category,  # single best guess, even when nothing clears the threshold
        "category_confidence": category_scores[top_category],
        "categories": [name for name, p in category_scores.items() if p > CATEGORY_THRESHOLD],
        "category_scores": category_scores,
        "urgency": urgency,  # integer 0-4
        "urgency_label": URGENCY_LEVELS[urgency],
        "urgency_score": round(urgency_score, 2),
    }


##########FASTAPI##################3

initialize_db()

app = FastAPI()
@app.get("/")
async def root():
    return {"message": "MeshGuardian Server is Running!"}

# Allow Dev 1's frontend to connect during local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store active dashboard connections
active_dashboards = []

@app.websocket("/ws/dispatch")
async def dispatch_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_dashboards.append(websocket)
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in active_dashboards:
            active_dashboards.remove(websocket)

async def broadcast(payload: dict):
    """Send a JSON message to every connected dispatch dashboard."""
    for dashboard in list(active_dashboards):
        try:
            await dashboard.send_json(payload)
        except Exception:
            # Dashboard went away mid-send; drop it so the rest still get the message
            if dashboard in active_dashboards:
                active_dashboards.remove(dashboard)


def incident_record(incident: dict) -> dict:
    """A stored incident as the dashboard's record, with the dispatcher's status applied."""
    record = dict(incident["response_body"]["triage"])
    record.setdefault("id", incident["incident_id"])
    if incident["dispatch_status"] == "resolved":
        record["status"] = "Resolved"
    return record


class SOSRequest(BaseModel):
    """The sosRecord built by VictimForm.jsx. Only the phone number and message are required."""
    # Pass through any field the form adds later instead of rejecting or dropping it
    model_config = ConfigDict(extra="allow")

    phone_number: str
    message: str
    id: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    address: Optional[str] = None
    status: str = "Pending"
    timestamp: Optional[str] = None


@app.post("/api/submit_sos")
async def submit_sos(request: SOSRequest):
    # 0. A retry of an SOS we already hold (e.g. two dashboards relaying it): answer from storage
    if request.id:
        existing = await run_in_threadpool(get_incident, request.id)
        if existing is not None:
            return {**existing["response_body"], "triage": incident_record(existing)}

    # 1. Query Laya off the event loop so dashboards stay responsive
    async with predict_lock:
        result = await run_in_threadpool(triage, request.message)

    # 2. Format the data for the frontend: the full form record, with Laya's triage on top
    triage_result = {
        **request.model_dump(),
        "id": request.id or f"sos_{uuid.uuid4().hex[:12]}",
        "timestamp": request.timestamp or datetime.now(timezone.utc).isoformat(),
        "original_message": request.message,  # the name storage.py reads
        **result,
    }
    response = {"status": "success", "message": "SOS received and routed.", "triage": triage_result}

    # 3. Persist. A storage failure must not stop the SOS reaching dispatchers
    try:
        await run_in_threadpool(save_incident, response)
    except Exception as exc:
        print(f"Could not save incident {triage_result['id']}: {exc!r}")

    # 4. Broadcast to all connected dispatch dashboards
    await broadcast(triage_result)

    return response


@app.get("/api/incidents")
def list_incidents(limit: int = Query(200, ge=1, le=500)):
    """Recent incidents, newest first, for a dashboard that has just opened."""
    return [incident_record(incident) for incident in list_recent_incidents(limit)]


@app.post("/api/incidents/{incident_id}/resolve")
async def resolve_incident(incident_id: str):
    if not await run_in_threadpool(update_status, incident_id, "resolved"):
        raise HTTPException(status_code=404, detail="Unknown incident")
    await broadcast({"type": "status", "id": incident_id, "status": "Resolved"})
    return {"status": "success", "id": incident_id}


# Run this file with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
