import json

from pathlib import Path

from storage import (
    DB_PATH,
    initialize_db,
    save_incident,
    get_incident,
    list_recent_incidents,
    update_status,
)


def main():
    sample_path = Path(__file__).with_name(
        "sample_response.json"
    )

    with sample_path.open("r", encoding="utf-8") as file:
        response_body = json.load(file)

    initialize_db()

    incident = save_incident(response_body)

    print("Database:", DB_PATH)
    print("\nSaved incident:")
    print(json.dumps(incident, indent=2))

    saved_body = incident["response_body"]
    triage = saved_body["triage"]

    # Verify that the supplied data has been preserved.
    assert saved_body["status"] == "success"
    assert triage["category"] == "Fire"

    assert triage["categories"] == [
        "Fire",
        "Trapped/Structural",
        "Medical",
    ]

    assert triage["category_scores"]["Medical"] == 0.81
    assert triage["is_life_threatening"] is True
    assert triage["threat_confidence"] == 0.8

    incident_id = incident["incident_id"]

    # Verify retrieval using the generated incident ID.
    retrieved = get_incident(incident_id)

    assert retrieved is not None
    assert retrieved["response_body"] == response_body

    # Verify dispatch status is separate from API status.
    assert incident["dispatch_status"] == "new"

    assert update_status(incident_id, "acknowledged")

    updated = get_incident(incident_id)
    assert updated["dispatch_status"] == "acknowledged"

    # Verify recent-incident retrieval.
    recent = list_recent_incidents(5)
    assert any(
        item["incident_id"] == incident_id
        for item in recent
    )

    print("\nAll storage checks passed.")


if __name__ == "__main__":
    main()
