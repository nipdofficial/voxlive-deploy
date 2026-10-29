"""Central policy for organizer-owned and legacy transcript records."""

from fastapi import HTTPException
from app.models.auth import Role, SessionRecord
from app.models.schemas import TranscriptRecord


def can_access_history(record: TranscriptRecord, session: SessionRecord) -> bool:
    """Unowned legacy records are visible only to administrators.

    Administrators can review history; organizers can access only records
    explicitly associated with their account. Never infer legacy ownership.
    """
    return session.role == Role.admin or (
        record.organizer_user_id is not None
        and record.organizer_user_id == session.user_id
    )


def require_history_access(record: TranscriptRecord | None, session: SessionRecord) -> TranscriptRecord:
    # Use the same response for missing and unauthorized IDs to avoid leaking
    # whether another organizer's transcript exists.
    if record is None or not can_access_history(record, session):
        raise HTTPException(status_code=404, detail="Transcript not found")
    return record
