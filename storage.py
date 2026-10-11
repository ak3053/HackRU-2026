"""SQLite storage for the Emergency SOS application."""

import json
import math
import os
import sqlite3

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from uuid import uuid4


DEFAULT_DB_PATH = (
    Path(__file__).resolve().parent
    / "data"
    / "emergency_sos.sqlite3"
)

DB_PATH = Path(
    os.environ.get("SOS_DB_PATH", str(DEFAULT_DB_PATH))
).expanduser().resolve()


def utc_now() -> str:
    """Return the current UTC time in ISO-8601 format."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    """Open a connection and close it after the operation."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row

    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize_db() -> None:
    """Create the incidents table if it does not exist."""

    with _connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS incidents (
                id TEXT PRIMARY KEY,
                received_at_utc TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL,

                response_status TEXT NOT NULL,
                response_message TEXT NOT NULL,

                phone_number TEXT,
                original_message TEXT NOT NULL,

                is_life_threatening INTEGER
                    CHECK (
                        is_life_threatening IS NULL
                        OR is_life_threatening IN (0, 1)
                    ),

                threat_confidence REAL
                    CHECK (
                        threat_confidence IS NULL
                        OR (
                            threat_confidence >= 0
                            AND threat_confidence <= 1
                        )
                    ),

                category TEXT,
                category_confidence REAL
                    CHECK (
                        category_confidence IS NULL
                        OR (
                            category_confidence >= 0
                            AND category_confidence <= 1
                        )
                    ),

                categories_json TEXT NOT NULL,
                category_scores_json TEXT NOT NULL,

                urgency INTEGER,
                urgency_label TEXT,
                urgency_score REAL,

                raw_response_json TEXT NOT NULL,

                dispatch_status TEXT NOT NULL DEFAULT 'new'
                    CHECK (
                        dispatch_status IN (
                            'new',
                            'acknowledged',
                            'resolved'
                        )
                    )
            )
            """
        )

    # Restrict access to the local database file.
    DB_PATH.chmod(0o600)


def _optional_number(
    field_name: str,
    value: Any,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
) -> Optional[float]:
    """Validate an optional numeric value."""
    if value is None:
        return None

    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
    ):
        raise ValueError(f"{field_name} must be numeric or None")

    number = float(value)

    if not math.isfinite(number):
        raise ValueError(f"{field_name} must be finite")

    if minimum is not None and number < minimum:
        raise ValueError(f"{field_name} is below its minimum")

    if maximum is not None and number > maximum:
        raise ValueError(f"{field_name} exceeds its maximum")

    return number


def _row_to_record(row: sqlite3.Row) -> Dict[str, Any]:
    """Return database metadata and the original response body."""

    return {
        "incident_id": row["id"],
        "received_at_utc": row["received_at_utc"],
        "updated_at_utc": row["updated_at_utc"],
        "dispatch_status": row["dispatch_status"],
        "response_body": json.loads(row["raw_response_json"]),
    }


def save_incident(
    response_body: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Save a complete JSON response body.

    The response_body follows the agreed structure:
    status, message, and a nested triage object.
    """

    if not isinstance(response_body, dict):
        raise ValueError("response_body must be a dictionary")

    if not isinstance(response_body.get("status"), str):
        raise ValueError("response_body.status must be a string")

    if not isinstance(response_body.get("message"), str):
        raise ValueError("response_body.message must be a string")

    triage = response_body.get("triage")

    if not isinstance(triage, dict):
        raise ValueError("response_body.triage must be an object")

    original_message = triage.get("original_message")

    if (
        not isinstance(original_message, str)
        or not original_message.strip()
    ):
        raise ValueError(
            "triage.original_message must be non-empty"
        )

    phone_number = triage.get("phone_number")

    # Phone numbers are identifiers, so store them as text.
    if phone_number is not None:
        if isinstance(phone_number, bool):
            raise ValueError("phone_number must be text or numeric")
        phone_number = str(phone_number)

    is_life_threatening = triage.get("is_life_threatening")

    if (
        is_life_threatening is not None
        and not isinstance(is_life_threatening, bool)
    ):
        raise ValueError(
            "is_life_threatening must be a Boolean or None"
        )

    threat_confidence = _optional_number(
        "threat_confidence",
        triage.get("threat_confidence"),
        minimum=0,
        maximum=1,
    )

    category_confidence = _optional_number(
        "category_confidence",
        triage.get("category_confidence"),
        minimum=0,
        maximum=1,
    )

    urgency_score = _optional_number(
        "urgency_score",
        triage.get("urgency_score"),
    )

    urgency = triage.get("urgency")

    if urgency is not None and (
        isinstance(urgency, bool)
        or not isinstance(urgency, int)
    ):
        raise ValueError("urgency must be an integer or None")

    category = triage.get("category")
    urgency_label = triage.get("urgency_label")

    if category is not None and not isinstance(category, str):
        raise ValueError("category must be a string or None")

    if (
        urgency_label is not None
        and not isinstance(urgency_label, str)
    ):
        raise ValueError("urgency_label must be a string or None")

    categories = triage.get("categories", [])
    category_scores = triage.get("category_scores", {})

    if not isinstance(categories, list) or not all(
        isinstance(item, str) for item in categories
    ):
        raise ValueError("categories must be a list of strings")

    if not isinstance(category_scores, dict):
        raise ValueError("category_scores must be an object")

    # Store each category score as a finite number.
    for name, score in category_scores.items():
        if not isinstance(name, str):
            raise ValueError("category score keys must be strings")

        _optional_number(f"category_scores[{name}]", score)

    # Validate that the complete response can be represented as JSON.
    raw_json = json.dumps(
        response_body,
        ensure_ascii=False,
        allow_nan=False,
    )

    categories_json = json.dumps(categories, ensure_ascii=False)
    scores_json = json.dumps(
        category_scores,
        ensure_ascii=False,
        allow_nan=False,
    )

    # Reuse the SOS record's own id so the frontend can address the incident later.
    incident_id = triage.get("id")

    if not isinstance(incident_id, str) or not incident_id.strip():
        incident_id = str(uuid4())

    timestamp = utc_now()

    with _connection() as conn:
        conn.execute(
            """
            INSERT INTO incidents (
                id,
                received_at_utc,
                updated_at_utc,
                response_status,
                response_message,
                phone_number,
                original_message,
                is_life_threatening,
                threat_confidence,
                category,
                category_confidence,
                categories_json,
                category_scores_json,
                urgency,
                urgency_label,
                urgency_score,
                raw_response_json,
                dispatch_status
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )
            """,
            (
                incident_id,
                timestamp,
                timestamp,
                response_body["status"],
                response_body["message"],
                phone_number,
                original_message.strip(),
                (
                    int(is_life_threatening)
                    if is_life_threatening is not None
                    else None
                ),
                threat_confidence,
                category,
                category_confidence,
                categories_json,
                scores_json,
                urgency,
                urgency_label,
                urgency_score,
                raw_json,
                "new",
            ),
        )

    saved = get_incident(incident_id)

    if saved is None:
        raise RuntimeError("Saved incident could not be retrieved")

    return saved


def get_incident(
    incident_id: str,
) -> Optional[Dict[str, Any]]:
    """Retrieve one incident by its generated ID."""

    with _connection() as conn:
        row = conn.execute(
            "SELECT * FROM incidents WHERE id = ?",
            (incident_id,),
        ).fetchone()

    return _row_to_record(row) if row is not None else None


def list_recent_incidents(
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Retrieve the newest incidents for the dispatcher."""

    if not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")

    with _connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM incidents
            ORDER BY received_at_utc DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [_row_to_record(row) for row in rows]


def update_status(
    incident_id: str,
    status: str,
) -> bool:
    """Update dispatch status without overwriting API status."""

    allowed = {"new", "acknowledged", "resolved"}

    if status not in allowed:
        raise ValueError(f"status must be one of {sorted(allowed)}")

    with _connection() as conn:
        cursor = conn.execute(
            """
            UPDATE incidents
            SET dispatch_status = ?, updated_at_utc = ?
            WHERE id = ?
            """,
            (status, utc_now(), incident_id),
        )

    return cursor.rowcount > 0
