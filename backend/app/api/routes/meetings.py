import hmac
import io
import asyncio
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.responses import Response

from app.api.routes.history import delete_history, list_history, save_record
from app.api.routes.auth import current_session
from app.core.config import get_settings
from app.models.auth import SessionRecord
from app.services.auth_service import auth_store
from app.models.schemas import (
    JobStatus,
    MeetingConnection,
    MeetingCreate,
    MeetingEnd,
    MeetingFeedback,
    MeetingFeedbackRequest,
    MeetingStart,
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


def _same_secret(expected: str, supplied: str) -> bool:
    """Compare arbitrary user input without failing on non-ASCII text."""
    return hmac.compare_digest(expected.encode("utf-8"), supplied.encode("utf-8"))


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
        invitation_secret=session.invitation_secret if is_host else None,
        language=session.language,
        preferred_speaker_language=session.record.preferred_speaker_language,
        start_mode=session.record.start_mode,
        segments=sorted(
            (
                segment
                for segment in session.record.segments
                if segment.is_final and segment.translated_text
            ),
            key=lambda segment: (segment.sequence or 0, segment.start, segment.end),
        ),
    )


def _session_info(session) -> SessionInfo:
    return SessionInfo(
        room_code=session.code,
        meeting_id=session.record.id,
        title=session.title,
        language=session.language,
        preferred_speaker_language=session.record.preferred_speaker_language,
        start_mode=session.record.start_mode,
        max_participants=session.max_participants,
        current_participants=session.participant_count,
        is_active=session.started and not session.ending,
        is_started=session.started,
        created_at=session.created_at,
        scheduled_start=session.scheduled_start,
        scheduled_end=session.scheduled_end,
        started_at=session.record.started_at,
        ended_at=session.record.ended_at,
        speaker_name=session.record.participants[0].display_name if session.record.participants else None,
        status=session.status,
    )


@router.post("", response_model=MeetingConnection, status_code=status.HTTP_201_CREATED)
async def create_meeting(
    body: MeetingCreate,
    organizer: SessionRecord = Depends(current_session),
) -> MeetingConnection:
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
        preferred_speaker_language=body.preferred_speaker_language,
        session_type=SessionType.meeting,
        start_mode=body.start_mode,
        diarization=body.shared_mic,
        status=JobStatus.queued,
        organizer_user_id=organizer.user_id,
        scheduled_start=body.scheduled_start,
        scheduled_end=body.scheduled_end,
    )
    await save_record(record)
    session = await meeting_registry.create(
        record,
        body.language,
        title=body.title,
        max_participants=body.max_participants,
        scheduled_start=body.scheduled_start,
        scheduled_end=body.scheduled_end,
        organizer_user_id=organizer.user_id,
    )
    identity = participant_identity()
    participant = session.add_participant(identity, display_name, body.shared_mic)
    await save_record(record)
    await meeting_registry.persist_pending()
    token = create_join_token(session, identity, display_name, body.shared_mic, is_host=True)
    return _connection(session, participant, token, is_host=True)


@router.get("/mine", response_model=list[SessionInfo])
async def list_managed_meetings(
    organizer: SessionRecord = Depends(current_session),
) -> list[SessionInfo]:
    sessions = (
        session for session in meeting_registry.sessions.values()
        if session.organizer_user_id == organizer.user_id and not session.ending
    )
    return sorted((_session_info(session) for session in sessions), key=lambda item: item.created_at, reverse=True)


@router.get("/mine/history", response_model=list[TranscriptRecord])
async def list_managed_history(
    organizer: SessionRecord = Depends(current_session),
) -> list[TranscriptRecord]:
    return [record for record in await list_history(organizer=organizer) if record.organizer_user_id == organizer.user_id]


@router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_managed_meeting(
    code: str,
    organizer: SessionRecord = Depends(current_session),
) -> None:
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.organizer_user_id != organizer.user_id:
        raise HTTPException(status_code=403, detail="Only the session organizer can delete it")
    if session.started and not session.ending:
        raise HTTPException(status_code=409, detail="A live session must be ended before it can be removed")
    meeting_registry.sessions.pop(session.code, None)
    await meeting_registry.persist_pending()
    await delete_history(session.record.id, organizer)


@router.post("/{code}/organizer", response_model=MeetingConnection)
async def resume_organizer_meeting(
    code: str,
    organizer: SessionRecord = Depends(current_session),
) -> MeetingConnection:
    session = meeting_registry.get(code)
    if not session or session.ending:
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    if session.organizer_user_id != organizer.user_id:
        raise HTTPException(status_code=403, detail="Only the session organizer can open it")
    participant = session.record.participants[0]
    token = create_join_token(
        session,
        participant.identity,
        participant.display_name,
        participant.shared_mic,
        is_host=True,
    )
    return _connection(session, participant, token, is_host=True)


@router.get("/{code}", response_model=SessionInfo)
async def get_session_info(code: str, authorization: str | None = Header(default=None)) -> SessionInfo:
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    scheme, _, token = (authorization or "").partition(" ")
    organizer = await auth_store.authenticate(token) if scheme.lower() == "bearer" and token else None
    is_owner = organizer and organizer.user_id == session.organizer_user_id
    has_invitation = bool(scheme.lower() == "invite" and token and _same_secret(session.invitation_secret, token))
    if not is_owner and not has_invitation:
        raise HTTPException(status_code=404, detail="Session not found")
    return _session_info(session)


def _authorize_attendee(code: str, authorization: str | None):
    session = meeting_registry.get(code)
    scheme, _, token = (authorization or "").partition(" ")
    if not session or scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=404, detail="Session not found or access denied")
    try:
        from livekit import api
        settings = get_settings()
        claims = api.TokenVerifier(settings.livekit_api_key, settings.livekit_api_secret, leeway=timedelta(0)).verify(token)
        grants = claims.video
        if not grants or not grants.room_join or grants.room != session.room_name:
            raise ValueError("Wrong room")
        if not any(item.identity == claims.identity for item in session.record.participants):
            raise ValueError("Unknown participant")
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found or access denied") from None
    return session


@router.get("/{code}/transcript")
async def attendee_transcript(code: str, authorization: str | None = Header(default=None)) -> dict:
    """Return only the joined room's transcript to a valid room participant."""
    session = _authorize_attendee(code, authorization)
    return {"segments": [segment.model_dump() for segment in session.record.segments], "error": session.record.error}


@router.post("/{code}/start", response_model=SessionInfo)
async def start_meeting(code: str, body: MeetingStart, organizer: SessionRecord = Depends(current_session)) -> SessionInfo:
    session = meeting_registry.get(code)
    if not session or session.ending:
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    if session.organizer_user_id != organizer.user_id or not _same_secret(session.host_secret, body.host_secret):
        raise HTTPException(status_code=403, detail="Only the session host can start it")
    if session.scheduled_start and session.scheduled_start > datetime.now(timezone.utc):
        raise HTTPException(
            status_code=409,
            detail=f"This session is scheduled to start at {session.scheduled_start.isoformat()}",
        )
    await session.start()
    await meeting_registry.persist_pending()
    if session.task:
        session.task.add_done_callback(
            lambda task, room_code=code: meeting_registry.sessions.pop(room_code, None)
            if task.cancelled() or task.exception() else None
        )
    return _session_info(session)


@router.websocket("/{code}/audio")
async def stream_organizer_audio(code: str, websocket: WebSocket) -> None:
    """Receive the organizer's 16 kHz PCM capture for a managed meeting.

    LiveKit remains responsible for room presence and distributing transcript
    events. Capturing PCM here makes the transcription path deterministic even
    when a browser or mobile network does not expose its published WebRTC track
    to a hidden subscriber quickly enough.
    """
    await websocket.accept()
    try:
        hello = await websocket.receive_json()
        session = meeting_registry.get(code)
        host_secret = str(hello.get("host_secret") or "") if isinstance(hello, dict) else ""
        organizer_token = str(hello.get("token") or "") if isinstance(hello, dict) else ""
        identity = str(hello.get("participant_identity") or "") if isinstance(hello, dict) else ""
        if not session or session.ending or not session.started:
            await websocket.send_json({"type": "error", "message": "Session is not live"})
            await websocket.close(code=1008)
            return
        organizer = await auth_store.authenticate(organizer_token)
        if not organizer or session.organizer_user_id != organizer.user_id or not _same_secret(session.host_secret, host_secret):
            await websocket.send_json({"type": "error", "message": "Only the organizer can provide audio"})
            await websocket.close(code=1008)
            return
        participant = next((item for item in session.record.participants if item.identity == identity), None)
        if participant is None:
            await websocket.send_json({"type": "error", "message": "Organizer identity is not in this session"})
            await websocket.close(code=1008)
            return
        state = session._state_for(participant.identity, participant.display_name, True)
        await websocket.send_json({"type": "ready"})
        last_auth_check = time.monotonic()
        while not session.ending:
            try:
                data = await asyncio.wait_for(websocket.receive_bytes(), timeout=30)
            except TimeoutError:
                data = None
            if time.monotonic() - last_auth_check >= 30:
                current = await auth_store.authenticate(organizer_token)
                if not current or current.user_id != session.organizer_user_id:
                    await websocket.close(code=1008)
                    return
                last_auth_check = time.monotonic()
            if data is None:
                continue
            await session.ingest_pcm(state, data)
    except WebSocketDisconnect:
        return


@router.get("/{code}/qr", response_class=Response)
async def get_session_qr(code: str, organizer: SessionRecord = Depends(current_session)) -> Response:
    """Return a QR code PNG for the given session room code."""
    session = meeting_registry.get(code)
    if not session or session.organizer_user_id != organizer.user_id:
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
        qr.add_data(f"{app_url}/?session={code.upper()}#invite={session.invitation_secret}")
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
    if not _same_secret(session.invitation_secret, body.invitation):
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    if not session.started:
        raise HTTPException(status_code=409, detail="The organizer has not started this session yet")
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
async def update_meeting(code: str, body: MeetingUpdate, organizer: SessionRecord = Depends(current_session)) -> SessionInfo:
    session = meeting_registry.get(code)
    if not session or session.ending:
        raise HTTPException(status_code=404, detail="Session not found or already ended")
    if session.organizer_user_id != organizer.user_id or not _same_secret(session.host_secret, body.host_secret):
        raise HTTPException(status_code=403, detail="Only the session host can update it")
    session.language = body.language
    session.record.language = body.language
    await save_record(session.record)
    return _session_info(session)


@router.post("/{code}/end", status_code=status.HTTP_202_ACCEPTED)
async def end_meeting(code: str, body: MeetingEnd, organizer: SessionRecord = Depends(current_session)) -> dict[str, str]:
    session = meeting_registry.get(code)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.organizer_user_id != organizer.user_id or not _same_secret(session.host_secret, body.host_secret):
        raise HTTPException(status_code=403, detail="Only the session host can end it")
    await session.end()
    await meeting_registry.persist_pending()
    return {"id": session.record.id, "status": "processing"}


@router.post("/{code}/feedback", response_model=MeetingFeedback)
async def submit_feedback(code: str, body: MeetingFeedbackRequest, authorization: str | None = Header(default=None)) -> MeetingFeedback:
    session = _authorize_attendee(code, authorization)
    feedback = MeetingFeedback(
        display_name=body.display_name.strip(),
        rating=body.rating,
        comment=body.comment.strip(),
    )
    session.record.feedback.append(feedback)
    await save_record(session.record)
    return feedback
