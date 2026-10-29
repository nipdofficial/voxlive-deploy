import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    Language,
    SessionType,
    SpeakerRename,
    TranscriptEdit,
    TranscriptRecord,
    TranscriptSummary,
    TranscriptTranslate,
)
from app.services.gemini_service import GeminiService
from app.api.routes.auth import current_session
from app.models.auth import SessionRecord
from app.services.auth_service import auth_store
from app.services.history_access import can_access_history, require_history_access

router = APIRouter(prefix="/history", tags=["history"])
_records: dict[str, TranscriptRecord] = {}
_lock = asyncio.Lock()
_loaded = False
_summary_locks: dict[str, asyncio.Lock] = {}
logger = logging.getLogger(__name__)
_subscribers: dict[asyncio.Queue[dict], SessionRecord] = {}


async def _publish(event: dict) -> None:
    """Fan out status changes without allowing slow clients to block jobs."""
    for queue, session in tuple(_subscribers.items()):
        record = event.get("_access_record") or event.get("record")
        if isinstance(record, dict):
            record = TranscriptRecord.model_validate(record)
        if not record or not can_access_history(record, session):
            continue
        outgoing = {key: value for key, value in event.items() if key != "_access_record"}
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            queue.put_nowait(outgoing)
        except asyncio.QueueFull:
            logger.warning("Dropped history event for a slow subscriber")


def _history_path() -> Path:
    return get_settings().data_dir / "history.json"


def _write_history(payload: str) -> None:
    """Atomically replace history so a crash cannot leave partial JSON."""
    path = _history_path()
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


async def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    async with _lock:
        if _loaded:
            return
        path = _history_path()
        if path.exists():
            raw = await asyncio.to_thread(path.read_text, encoding="utf-8")
            for item in json.loads(raw or "[]"):
                record = TranscriptRecord.model_validate(item)
                _records[record.id] = record
        _loaded = True


async def save_record(record: TranscriptRecord) -> TranscriptRecord:
    await _ensure_loaded()
    record.updated_at = datetime.now(timezone.utc)
    async with _lock:
        _records[record.id] = record
        payload = json.dumps(
            [item.model_dump(mode="json") for item in _records.values()],
            ensure_ascii=False,
            indent=2,
        )
        await asyncio.to_thread(_write_history, payload)
    await _publish({"type": "record", "record": record.model_dump(mode="json")})
    return record


async def get_record(record_id: str) -> TranscriptRecord | None:
    await _ensure_loaded()
    return _records.get(record_id)


async def all_history() -> list[TranscriptRecord]:
    """Internal startup recovery only; never expose this helper as a route."""
    await _ensure_loaded()
    return list(_records.values())


@router.get("", response_model=list[TranscriptRecord])
async def list_history(
    q: str | None = None,
    language: Language | None = None,
    session_type: SessionType | None = None,
    status: JobStatus | None = None,
    organizer: SessionRecord = Depends(current_session),
) -> list[TranscriptRecord]:
    await _ensure_loaded()
    records = [item for item in _records.values() if can_access_history(item, organizer)]
    if language is not None:
        records = [item for item in records if item.language == language]
    if session_type is not None:
        records = [item for item in records if item.session_type == session_type]
    if status is not None:
        records = [item for item in records if item.status == status]
    if q:
        needle = q.casefold().strip()
        records = [
            item for item in records
            if needle in item.title.casefold() or needle in item.transcript.casefold()
        ]
    return sorted(records, key=lambda item: item.created_at, reverse=True)


@router.get("/{record_id}", response_model=TranscriptRecord)
async def history_detail(record_id: str, organizer: SessionRecord = Depends(current_session)) -> TranscriptRecord:
    return require_history_access(await get_record(record_id), organizer)


@router.patch("/{record_id}", response_model=TranscriptRecord)
async def edit_history(record_id: str, body: TranscriptEdit, organizer: SessionRecord = Depends(current_session)) -> TranscriptRecord:
    record = require_history_access(await get_record(record_id), organizer)
    if record.status != JobStatus.completed:
        raise HTTPException(status_code=409, detail="Only completed transcripts can be edited")
    if body.title is not None:
        record.title = body.title.strip()
    if body.segments is not None:
        record.segments = sorted(body.segments, key=lambda item: (item.start, item.end))
        record.transcript = "\n".join(
            (f"{item.speaker}: " if item.speaker else "") + item.text
            + (f"\nTranslation: {item.translated_text}" if item.translated_text and item.translated_text != item.text else "")
            for item in record.segments
        )
        record.summary = None
        record.summary_source_hash = None
    return await save_record(record)


@router.post("/{record_id}/speakers/rename", response_model=TranscriptRecord)
async def rename_speaker(record_id: str, body: SpeakerRename, organizer: SessionRecord = Depends(current_session)) -> TranscriptRecord:
    record = require_history_access(await get_record(record_id), organizer)
    changed = False
    for segment in record.segments:
        if segment.speaker == body.old_name:
            segment.speaker = body.new_name.strip()
            changed = True
    if not changed:
        raise HTTPException(status_code=404, detail="Speaker label not found")
    record.transcript = "\n".join(
        (f"{item.speaker}: " if item.speaker else "") + item.text
        + (f"\nTranslation: {item.translated_text}" if item.translated_text and item.translated_text != item.text else "")
        for item in record.segments
    )
    record.summary = None
    record.summary_source_hash = None
    return await save_record(record)


@router.post("/{record_id}/translate", response_model=TranscriptRecord)
async def translate_history(record_id: str, body: TranscriptTranslate, organizer: SessionRecord = Depends(current_session)) -> TranscriptRecord:
    record = require_history_access(await get_record(record_id), organizer)
    if record.status != JobStatus.completed or not record.segments:
        raise HTTPException(status_code=409, detail="A completed transcript is required")
    if body.target_language != Language.tamil:
        raise HTTPException(status_code=422, detail="Tamil is the only supported translation target")
    try:
        translated = await GeminiService().translate_segments(record.segments, body.target_language)
    except Exception as exc:
        logger.exception("Translation failed for %s", record_id)
        raise HTTPException(status_code=502, detail="Translation failed; please try again") from exc
    for segment, text in zip(record.segments, translated, strict=True):
        segment.translated_text = text
    return await save_record(record)


@router.websocket("/events")
async def history_events(websocket: WebSocket) -> None:
    await websocket.accept()
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        token = hello.get("token", "") if isinstance(hello, dict) else ""
        session = await auth_store.authenticate(token)
        if not session:
            await websocket.close(code=1008)
            return
        _subscribers[queue] = session
        await websocket.send_json({"type": "ready"})
        while True:
            event_task = asyncio.create_task(queue.get())
            receive_task = asyncio.create_task(websocket.receive())
            try:
                done, _ = await asyncio.wait({event_task, receive_task}, timeout=30, return_when=asyncio.FIRST_COMPLETED)
                if receive_task in done and receive_task.result().get("type") == "websocket.disconnect":
                    break
                event = event_task.result() if event_task in done else None
            finally:
                for task in (event_task, receive_task):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(event_task, receive_task, return_exceptions=True)
            session = await auth_store.authenticate(token)
            if not session:
                await websocket.close(code=1008)
                return
            _subscribers[queue] = session
            if event is not None:
                await websocket.send_json(event)
    except (WebSocketDisconnect, TimeoutError, asyncio.CancelledError):
        pass
    finally:
        _subscribers.pop(queue, None)


@router.get("/{record_id}/audio", response_class=FileResponse)
async def history_audio(record_id: str, organizer: SessionRecord = Depends(current_session)) -> FileResponse:
    record = require_history_access(await get_record(record_id), organizer)
    if not record.audio_filename:
        raise HTTPException(status_code=404, detail="Recorded audio not found")
    path = get_settings().data_dir / "audio" / Path(record.audio_filename).name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Recorded audio not found")
    return FileResponse(path, filename=path.name)


def _summary_source(record: TranscriptRecord) -> tuple[str, str]:
    if record.segments:
        lines = [
            f"[{item.start:.2f}] "
            f"{f'{item.speaker}: ' if item.speaker else ''}{item.text}"
            for item in record.segments
            if item.text
        ]
        text = "\n".join(lines)
    else:
        text = record.transcript.strip()
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return text, digest


@router.post("/{record_id}/summary", response_model=TranscriptSummary)
async def generate_summary(record_id: str, organizer: SessionRecord = Depends(current_session)) -> TranscriptSummary:
    record = require_history_access(await get_record(record_id), organizer)
    if record.status != JobStatus.completed:
        raise HTTPException(status_code=409, detail="Transcript must be completed before summarizing")
    transcript, source_hash = _summary_source(record)
    if len(transcript.strip()) < 10:
        raise HTTPException(status_code=422, detail="Transcript is too short to summarize")
    if record.summary and record.summary_source_hash == source_hash:
        return record.summary

    lock = _summary_locks.setdefault(record_id, asyncio.Lock())
    async with lock:
        current = await get_record(record_id)
        if not current:
            raise HTTPException(status_code=404, detail="Transcript not found")
        transcript, source_hash = _summary_source(current)
        if current.summary and current.summary_source_hash == source_hash:
            return current.summary
        try:
            content = await GeminiService().summarize_transcript(transcript, current.language)
        except Exception as exc:
            logger.exception("Summary generation failed for %s", record_id)
            raise HTTPException(
                status_code=502,
                detail="Summary generation failed; please try again",
            ) from exc

        latest = await get_record(record_id)
        if not latest:
            raise HTTPException(status_code=404, detail="Transcript not found")
        _, latest_hash = _summary_source(latest)
        if latest_hash != source_hash:
            raise HTTPException(status_code=409, detail="Transcript changed while generating summary")
        latest.summary = TranscriptSummary(**content.model_dump())
        latest.summary_source_hash = source_hash
        await save_record(latest)
        return latest.summary


@router.delete("/{record_id}", status_code=204)
async def delete_history(record_id: str, organizer: SessionRecord = Depends(current_session)) -> None:
    await _ensure_loaded()
    require_history_access(_records.get(record_id), organizer)
    async with _lock:
        record = _records.pop(record_id)
        payload = json.dumps(
            [item.model_dump(mode="json") for item in _records.values()],
            ensure_ascii=False,
            indent=2,
        )
        await asyncio.to_thread(_write_history, payload)
    if record.audio_filename:
        audio_path = get_settings().data_dir / "audio" / Path(record.audio_filename).name
        if audio_path.is_file():
            await asyncio.to_thread(audio_path.unlink)
    for filename in record.participant_audio.values():
        audio_path = get_settings().data_dir / "audio" / Path(filename).name
        if audio_path.is_file():
            await asyncio.to_thread(audio_path.unlink)
    await _publish({"type": "deleted", "id": record_id, "_access_record": record})
