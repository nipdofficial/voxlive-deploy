import hmac
import io

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import Response

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    MeetingConnection,
    MeetingCreate,
    MeetingEnd,
    MeetingJoin,
    MeetingUpdate,
    SessionInfo,
    SessionType,
    TranscriptRecord,
)
from app.services.meeting_service import (
    create_join_token,
    meeting_registry,
    normalize_display_name,
    participant_identity,
    require_livekit_settings,
)

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _connection(session, participant, token: str, *, is_host: bool) -> MeetingConnection:
    return MeetingConnection(
        livekit_url=get_settings().livekit_url or "",
        token=token,
        room_code=session.code,
        meeting_id=session.record.id,
        participant_identity=participant.identity,
        display_name=participant.display_name,
        is_host=is_host,
        host_secret=session.host_secret if is_host else None,
        language=session.language,
    )


def _session_info(session) -> SessionInfo:
    return SessionInfo(
        room_code=session.code,
        meeting_id=session.record.id,
        title=session.title,
        language=session.language,
        max_participants=session.max_participants,
        current_participants=session.participant_count,
        is_active=not session.ending,
        created_at=session.created_at,
    )


@router.post("", response_model=MeetingConnection, status_code=status.HTTP_201_CREATED)
async def create_meeting(body: MeetingCreate) -> MeetingConnection:
    try:
        require_livekit_settings()
        display_name = normalize_display_name(body.display_name)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    record = TranscriptRecord(
        title=body.title,
        language=body.language,
        session_type=SessionType.meeting,
        diarization=body.shared_mic,
        status=JobStatus.queued,
    )
    await save_record(record)
    session = await meeting_registry.create(
        record,
        body.language,
        title=body.title,
        max_participants=body.max_participants,
    )
    identity = participant_identity()
    participant = session.add_participant(identity, display_name, body.shared_mic)
    await save_record(record)
    token = create_join_token(session, identity, display_name, body.shared_mic, is_host=True)
    return _connection(session, participant, token, is_host=True)


@router.get("/{code}", response_model=SessionInfo)
async def get_session_info(code: str) -> SessionInfo:
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_info(session)


@router.get("/{code}/qr", response_class=Response)
async def get_session_qr(code: str) -> Response:
    """Return a QR code PNG for the given session room code."""
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        import qrcode

        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=4,
        )
        app_url = get_settings().public_app_url.rstrip("/")
        qr.add_data(f"{app_url}/?session={code.upper()}")
        qr.make(fit=True)
        # qrcode[pil] is installed in the deployment. Use its Pillow image
        # backend; PyPNGImage requires a separate pypng dependency and caused
        # the production endpoint to return 501 with a blank QR container.
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf)
        buf.seek(0)
        return Response(content=buf.getvalue(), media_type="image/png")
    except ImportError:
        raise HTTPException(status_code=501, detail="QR code generation not available (install qrcode[pil])")


@router.post("/{code}/join", response_model=MeetingConnection)
async def join_meeting(code: str, body: MeetingJoin) -> MeetingConnection:
    session = meeting_registry.get(code)
    if not session or session.ending:
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    try:
        display_name = normalize_display_name(body.display_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    identity = participant_identity()
    try:
        participant = session.add_participant(identity, display_name, body.shared_mic)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await save_record(session.record)
    token = create_join_token(session, identity, display_name, body.shared_mic, is_host=False)
    return _connection(session, participant, token, is_host=False)


@router.patch("/{code}", response_model=SessionInfo)
async def update_meeting(code: str, body: MeetingUpdate) -> SessionInfo:
    session = meeting_registry.get(code)
    if not session or session.ending:
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    if not hmac.compare_digest(session.host_secret, body.host_secret):
        raise HTTPException(status_code=403, detail="Only the session host can update it")
    session.language = body.language
    session.record.language = body.language
    await save_record(session.record)
    return _session_info(session)


@router.post("/{code}/end", status_code=status.HTTP_202_ACCEPTED)
async def end_meeting(code: str, body: MeetingEnd) -> dict[str, str]:
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not hmac.compare_digest(session.host_secret, body.host_secret):
        raise HTTPException(status_code=403, detail="Only the session host can end it")
    await session.end()
    return {"id": session.record.id, "status": "processing"}
