import asyncio
import io
import logging
import wave
from contextlib import suppress
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google.genai import types

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    Language,
    LiveStart,
    ProcessingStage,
    SessionType,
    SpokenLanguage,
    TranscriptRecord,
    TranscriptSegment,
)
from app.services.audio_service import pcm_rms as _pcm_rms, wav_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import (
    GeminiService,
    detect_script_language,
    has_expected_script,
)

router = APIRouter(tags=["live"])
logger = logging.getLogger(__name__)
_background_tasks: set[asyncio.Task[None]] = set()


def _pcm_wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def _live_language(value: str | None) -> SpokenLanguage | None:
    if not value:
        return None
    normalized = value.casefold()
    if normalized.startswith("si"):
        return SpokenLanguage.sinhala
    if normalized.startswith("ta"):
        return SpokenLanguage.tamil
    if normalized.startswith("en"):
        return SpokenLanguage.english
    return SpokenLanguage.unknown


def _live_language_codes(language: Language) -> list[str]:
    """Return BCP-47 hints, constrained to VoxLive's supported input modes."""
    return {
        Language.sinhala: ["si-LK"],
        Language.tamil: ["ta-IN"],
        Language.english: ["en-US"],
        Language.mixed: ["si-LK", "ta-IN", "en-US"],
    }[language]


def _live_text_matches_mode(text: str, language: Language) -> bool:
    expected = {
        Language.sinhala: SpokenLanguage.sinhala,
        Language.tamil: SpokenLanguage.tamil,
        Language.english: SpokenLanguage.english,
    }.get(language)
    detected = detect_script_language(text)
    if language == Language.mixed:
        # Mixed mode is intentionally limited to Sinhala, Tamil and English.
        return detected in {
            SpokenLanguage.sinhala,
            SpokenLanguage.tamil,
            SpokenLanguage.english,
        } or not any(char.isalpha() for char in text)
    if expected is None:
        return True
    if detected == SpokenLanguage.unknown:
        return not any(char.isalpha() for char in text)
    return detected == expected and has_expected_script(text, expected)


def _gate_live_pcm(pcm: bytes, threshold: float) -> bytes:
    """Replace quiet mic noise with silence while preserving audio timing."""
    if not pcm or _pcm_rms(pcm) < threshold:
        return bytes(len(pcm))
    return pcm


def _live_detected_language(
    value: str | None, text: str, requested: Language | None = None
) -> SpokenLanguage:
    """Prefer the returned script when the API's language tag disagrees."""
    script_language = detect_script_language(text)
    if script_language != SpokenLanguage.unknown:
        return script_language
    if requested and requested != Language.mixed:
        return {
            Language.sinhala: SpokenLanguage.sinhala,
            Language.tamil: SpokenLanguage.tamil,
            Language.english: SpokenLanguage.english,
        }.get(requested, _live_language(value) or SpokenLanguage.unknown)
    return _live_language(value) or SpokenLanguage.unknown


def _seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value.removesuffix("s"))
    except ValueError:
        return None


def _live_segment(
    transcription: types.Transcription,
    fallback_start: float,
    requested_language: Language | None = None,
) -> TranscriptSegment | None:
    text = (transcription.text or "").strip()
    if not text:
        return None
    if requested_language and not _live_text_matches_mode(text, requested_language):
        return None
    words = transcription.words or []
    start = _seconds(words[0].start_offset) if words else None
    end = _seconds(words[-1].end_offset) if words else None
    start = fallback_start if start is None else max(fallback_start, start)
    end = max(start + 0.05, end or start + max(0.25, len(text) * 0.06))
    return TranscriptSegment(
        start=start,
        end=end,
        text=text,
        speaker=transcription.speaker_label,
        detected_language=_live_detected_language(
            transcription.language_code, text, requested_language
        ),
    )


def _write_pcm_wav(path: Path, pcm: bytes, sample_rate: int) -> None:
    path.write_bytes(_pcm_wav_bytes(pcm, sample_rate))


def _raw_to_wav(raw_path: Path, path: Path, sample_rate: int) -> None:
    """Wrap a streamed PCM file as WAV without loading the session into RAM."""
    with raw_path.open("rb") as source, wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        while chunk := source.read(1024 * 1024):
            output.writeframesraw(chunk)


def _is_committed_segment(segment: TranscriptSegment, commit_after: float) -> bool:
    return (segment.start + segment.end) / 2 >= commit_after


def _same_preview_segment(left: TranscriptSegment, right: TranscriptSegment) -> bool:
    """Detect a repeated phrase returned by two overlapping preview chunks."""
    if " ".join(left.text.casefold().split()) != " ".join(right.text.casefold().split()):
        return False
    overlap = min(left.end, right.end) - max(left.start, right.start)
    return overlap >= -0.15


def _append_preview_segment(
    record: TranscriptRecord, segment: TranscriptSegment
) -> bool:
    if any(_same_preview_segment(saved, segment) for saved in record.segments):
        return False
    record.segments.append(segment)
    record.segments.sort(key=lambda item: (item.start, item.end))
    return True


def _can_finalize_from_full_audio(pcm_size: int) -> bool:
    """Return whether the final pass can safely replace unfinished previews."""
    settings = get_settings()
    wav_header_size = 44
    return (
        settings.live_finalize_full_audio
        and pcm_size + wav_header_size <= settings.max_upload_mb * 1024 * 1024
    )


def _enqueue_latest_preview(
    queue: asyncio.Queue[tuple[bytes, float, float] | None],
    item: tuple[bytes, float, float],
) -> bool:
    """Keep audio capture responsive when Gemini preview calls fall behind.

    Live previews are provisional and the retained recording receives an
    authoritative full-audio pass after Stop. Dropping the oldest queued
    preview is therefore safer than blocking the WebSocket audio receiver.
    """
    dropped = False
    if queue.full():
        try:
            queue.get_nowait()
            dropped = True
        except asyncio.QueueEmpty:
            pass
    queue.put_nowait(item)
    return dropped


def _start_background_finalization(record: TranscriptRecord, path: Path) -> None:
    """Keep a strong reference until background finalization completes."""
    task = asyncio.create_task(_finalize_live(record, path))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _transcribe_live_chunk(
    gemini: GeminiService,
    chunk: bytes,
    sample_rate: int,
    record: TranscriptRecord,
    offset: float,
) -> list[TranscriptSegment]:
    settings = get_settings()
    request = {
        # This fallback uses generateContent; the Live-only model cannot be
        # called through that endpoint. Keep it on the 3.8 Flash audio path.
        "model": settings.gemini_text_model,
        "timestamp_offset": offset,
        "include_speakers": record.diarization,
        "audio_duration_seconds": len(chunk) / (sample_rate * 2),
        "request_timeout_seconds": settings.gemini_live_timeout_seconds,
    }
    segments = await gemini.transcribe_file(
        _pcm_wav_bytes(chunk, sample_rate),
        "audio/wav",
        record.language,
        **request,
        # Live sessions use Mixed mode in the client. Keep the preview path
        # language-aware so Sinhala/Tamil audio is transcribed in its native
        # script instead of being sent through the English-oriented plain-text
        # transcribe model. The structured response already classifies each
        # utterance; defer the extra audio-only verifier to finalization so it
        # does not add a second network round trip to every live chunk.
        verify_mixed_language=False,
        use_structured_mixed_model=True,
    )
    return [
        segment
        for segment in segments
        if _live_text_matches_mode(segment.text, record.language)
    ]


async def _finalize_live(record: TranscriptRecord, path: Path) -> None:
    record.status = JobStatus.processing
    settings = get_settings()
    record.processing_stage = (
        ProcessingStage.transcribing
        if settings.live_finalize_full_audio
        else ProcessingStage.diarizing
        if record.diarization and record.segments
        else ProcessingStage.saving_audio
    )
    await save_record(record)
    try:
        if settings.live_finalize_full_audio:
            # Chunk results are a low-latency preview. Re-transcribe the retained
            # recording once so chunk boundaries cannot corrupt the final result.
            preview_segments = record.segments
            try:
                audio = await asyncio.to_thread(path.read_bytes)
                inline_limit = settings.max_upload_mb * 1024 * 1024
                energy = wav_rms(audio)
                silence_threshold = getattr(settings, "live_silence_rms_threshold", 0.0)
                if energy is not None and energy < silence_threshold:
                    record.segments = []
                elif len(audio) <= inline_limit:
                    final_segments = await GeminiService().transcribe_file(
                        audio,
                        "audio/wav",
                        record.language,
                        model=settings.gemini_batch_model,
                        include_speakers=record.diarization,
                        audio_duration_seconds=record.duration_seconds,
                    )
                    # A provider can validly return an empty result for a
                    # short/noisy full pass. Never erase useful live captions
                    # in that case; keep the preview as the completed record.
                    if final_segments:
                        record.segments = [
                            segment
                            for segment in final_segments
                            if _live_text_matches_mode(segment.text, record.language)
                        ]
                        if not record.segments and preview_segments:
                            record.segments = preview_segments
                            record.error = (
                                "Final pass returned text outside the selected language mode; "
                                "live captions retained"
                            )
                    else:
                        record.segments = preview_segments
                        record.error = (
                            "Final quality pass returned no speech; live preview retained"
                        ) if preview_segments else "No speech was detected"
                    if getattr(settings, "auto_translate", False) and record.segments and any(
                        not item.translated_text for item in record.segments
                    ):
                        final_gemini = GeminiService()
                        translations = await final_gemini.translate_segments(
                            record.segments, settings.target_language
                        )
                        record.segments = [
                            item.model_copy(update={"translated_text": translated})
                            for item, translated in zip(
                                record.segments, translations, strict=True
                            )
                        ]
                    record.error = None
                else:
                    record.error = (
                        "Full-session quality pass skipped because the recording "
                        f"exceeds {settings.max_upload_mb} MB; chunk previews were retained"
                    )
            except Exception as exc:
                record.segments = preview_segments
                record.error = f"Full-session quality pass unavailable: {exc}"
        if record.diarization and record.segments:
            record.processing_stage = ProcessingStage.diarizing
            await save_record(record)
            try:
                speakers = await diarize_file(str(path))
                record.segments = merge_transcript_and_speakers(record.segments, speakers)
            except Exception as exc:
                # Preserve the authoritative Gemini speaker labels when the
                # optional local refinement cannot safely load or execute.
                if any(item.speaker for item in record.segments):
                    warning = (
                        "Local speaker diarization unavailable; using Gemini speaker "
                        f"labels: {exc}"
                    )
                else:
                    record.diarization = False
                    warning = f"Speaker diarization unavailable: {exc}"
                record.error = f"{record.error}; {warning}" if record.error else warning
        record.transcript = "\n".join(
            (f"{item.speaker}: " if item.speaker else "") + item.text
            + (f"\nTranslation: {item.translated_text}" if item.translated_text and item.translated_text != item.text else "")
            for item in record.segments
        )
        record.status = JobStatus.completed
        record.processing_stage = None
    except Exception as exc:
        logger.exception("Live finalize failed for record %s", record.id)
        record.status = JobStatus.failed
        record.processing_stage = None
        record.error = str(exc)
    await save_record(record)


@router.websocket("/live")
async def live_transcription(websocket: WebSocket) -> None:
    await websocket.accept()
    pending = bytearray()
    pcm_size = 0
    record: TranscriptRecord | None = None
    raw_path: Path | None = None
    raw_file = None
    stopped = False
    workers: list[asyncio.Task[None]] = []
    translation_tasks: set[asyncio.Task[None]] = set()
    live_connect = None
    live_entered = False
    fallback_active = False
    try:
        start = LiveStart.model_validate(await websocket.receive_json())
        record = TranscriptRecord(
            title=start.title,
            language=start.language,
            session_type=start.session_type,
            diarization=start.diarization,
            status=JobStatus.processing,
            processing_stage=ProcessingStage.recording,
            audio_filename="pending.wav",
        )
        record.audio_filename = f"{record.id}.wav"
        raw_path = get_settings().data_dir / "audio" / f"{record.id}.pcm.part"
        raw_file = raw_path.open("wb")
        await save_record(record)
        await websocket.send_json({"type": "ready", "id": record.id})

        settings = get_settings()
        gemini = GeminiService()
        # Only the Live mode may translate line by line. Enforce this on the
        # backend so older clients cannot accidentally enable it for Record.
        realtime_translation = (
            start.session_type == SessionType.live and start.realtime_translation
        )
        live_language_codes = _live_language_codes(start.language)
        try:
            live_connect = gemini.client.aio.live.connect(
                model=settings.gemini_live_model,
                config=types.LiveConnectConfig(
                    response_modalities=["TEXT"],
                    input_audio_transcription=types.AudioTranscriptionConfig(
                        language_codes=live_language_codes,
                        mode="VERBATIM",
                    ),
                ),
            )
            live_session = await live_connect.__aenter__()
            live_entered = True
        except Exception as exc:
            # Some Vertex projects do not yet have Gemini Live model access.
            # Keep the WebSocket and recording alive using the existing
            # generateContent chunk path rather than failing before audio is
            # processed. The final full-audio pass remains authoritative.
            logger.warning("Gemini Live unavailable; using chunk preview fallback: %s", exc)
            record.error = f"Live preview fallback active: {exc}"
            live_connect = None
            live_session = None
        queue: asyncio.Queue[tuple[bytes, float] | None] = asyncio.Queue(
            maxsize=max(4, getattr(settings, "live_preview_queue_size", 50))
        )
        chunk_bytes = max(
            2,
            int(settings.live_stream_chunk_ms * start.sample_rate * 2 / 1000),
        )
        last_final_end = 0.0
        queued_preview_offset = 0.0

        async def translate_live_segment(segment: TranscriptSegment) -> None:
            """Add Tamil to one committed line without blocking live captions."""
            current_task = asyncio.current_task()
            try:
                if not settings.auto_translate or not realtime_translation:
                    return
                translations = await GeminiService().translate_segments(
                    [segment], settings.target_language
                )
                translated_text = translations[0] if translations else ""
                if not translated_text:
                    return
                for index, saved in enumerate(record.segments):
                    if (
                        saved.start == segment.start
                        and saved.end == segment.end
                        and saved.text == segment.text
                    ):
                        translated_segment = saved.model_copy(
                            update={"translated_text": translated_text}
                        )
                        record.segments[index] = translated_segment
                        await save_record(record)
                        await websocket.send_json(
                            {
                                "type": "translation",
                                "segment": translated_segment.model_dump(),
                            }
                        )
                        break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Live line translation skipped: %s", exc)
            finally:
                if current_task is not None:
                    translation_tasks.discard(current_task)

        async def send_live_audio() -> None:
            nonlocal fallback_active
            warning_sent = False
            while True:
                queued = await queue.get()
                if queued is None:
                    await live_session.send_realtime_input(audio_stream_end=True)
                    return
                chunk, _offset = queued
                try:
                    await live_session.send_realtime_input(
                        audio=types.Blob(
                            data=chunk,
                            mime_type=f"audio/pcm;rate={start.sample_rate}",
                        )
                    )
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    fallback_active = True
                    logger.exception("Gemini Live audio send failed")
                    record.error = f"Live API unavailable; chunk preview fallback active: {exc}"
                    await save_record(record)
                    if not warning_sent:
                        await websocket.send_json(
                            {
                                "type": "warning",
                                "message": "Live preview is delayed; audio is still recording",
                            }
                        )
                        warning_sent = True
                    # The Live API can accept the handshake and reject the
                    # first audio frame when the project lacks model access.
                    # Continue consuming audio through the lower-rate chunk
                    # fallback instead of killing the recording WebSocket.
                    fallback_buffer = bytearray(chunk)
                    fallback_offset = _offset
                    fallback_chunk_bytes = start.sample_rate * 2 * 1
                    while True:
                        next_item = await queue.get()
                        if next_item is None:
                            if fallback_buffer:
                                await process_fallback_chunk(bytes(fallback_buffer), fallback_offset)
                            return
                        next_chunk, next_offset = next_item
                        fallback_buffer.extend(next_chunk)
                        if len(fallback_buffer) < fallback_chunk_bytes:
                            continue
                        await process_fallback_chunk(bytes(fallback_buffer), fallback_offset)
                        fallback_buffer.clear()
                        fallback_offset = next_offset + len(next_chunk) / (start.sample_rate * 2)

        async def process_fallback_chunk(chunk: bytes, offset: float) -> None:
            if _pcm_rms(chunk) < settings.live_silence_rms_threshold:
                return
            segments = await _transcribe_live_chunk(
                gemini, chunk, start.sample_rate, record, offset
            )
            for segment in segments:
                if not _append_preview_segment(record, segment):
                    continue
                await websocket.send_json(
                    {"type": "transcript", "segment": segment.model_dump()}
                )
                if realtime_translation and settings.auto_translate:
                    translation_task = asyncio.create_task(
                        translate_live_segment(segment)
                    )
                    translation_tasks.add(translation_task)
            await save_record(record)

        async def send_chunk_preview_fallback() -> None:
            nonlocal fallback_active
            fallback_active = True
            fallback_buffer = bytearray()
            fallback_offset = 0.0
            fallback_chunk_bytes = start.sample_rate * 2 * 1
            while True:
                queued = await queue.get()
                if queued is None:
                    if fallback_buffer:
                        await process_fallback_chunk(bytes(fallback_buffer), fallback_offset)
                    return
                chunk, offset = queued
                if not fallback_buffer:
                    fallback_offset = offset
                fallback_buffer.extend(chunk)
                if len(fallback_buffer) < fallback_chunk_bytes:
                    continue
                try:
                    await process_fallback_chunk(bytes(fallback_buffer), fallback_offset)
                    fallback_buffer.clear()
                except asyncio.CancelledError:
                    return
                except Exception as exc:
                    record.error = f"Live chunk preview delayed: {exc}"
                    await save_record(record)

        async def receive_live_transcripts() -> None:
            nonlocal last_final_end
            try:
                while True:
                    async for response in live_session.receive():
                        content = response.server_content
                        if content is None:
                            continue
                        interim = content.interim_input_transcription
                        if interim and interim.text:
                            if not _live_text_matches_mode(interim.text, start.language):
                                continue
                            await websocket.send_json(
                                {
                                    "type": "interim",
                                    "text": interim.text,
                                    "detected_language": _live_detected_language(
                                        interim.language_code,
                                        interim.text,
                                        start.language,
                                    ),
                                }
                            )
                        final = content.input_transcription
                        if final is None:
                            continue
                        segment = _live_segment(final, last_final_end, start.language)
                        if segment is None:
                            continue
                        last_final_end = segment.end
                        if not _append_preview_segment(record, segment):
                            continue
                        await websocket.send_json(
                            {"type": "transcript", "segment": segment.model_dump()}
                        )
                        if settings.auto_translate and realtime_translation:
                            translation_task = asyncio.create_task(
                                translate_live_segment(segment)
                            )
                            translation_tasks.add(translation_task)
            except asyncio.CancelledError:
                return

        if live_session is None:
            workers = [asyncio.create_task(send_chunk_preview_fallback())]
        else:
            sender_task = asyncio.create_task(send_live_audio())
            receiver_task = asyncio.create_task(receive_live_transcripts())
            workers = [sender_task, receiver_task]
        workers_gather = asyncio.gather(*workers, return_exceptions=True)
        # Gemini Live sessions are currently limited to ten minutes. Keep the
        # application setting configurable, but never advertise a longer live
        # session than the provider can maintain.
        live_max_minutes = min(settings.max_live_minutes, 10.0)
        max_pcm_bytes = int(live_max_minutes * 60 * start.sample_rate * 2)
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                chunk = message["bytes"]
                if pcm_size + len(chunk) > max_pcm_bytes:
                    raise ValueError(
                        f"Live session exceeds the {live_max_minutes:g} minute limit"
                    )
                pcm_size += len(chunk)
                pending.extend(chunk)
                while len(pending) >= chunk_bytes:
                    live_chunk = _gate_live_pcm(
                        bytes(pending[:chunk_bytes]),
                        settings.live_voice_rms_threshold,
                    )
                    raw_file.write(live_chunk)
                    if queue.full():
                        queue.get_nowait()
                    queue.put_nowait((live_chunk, queued_preview_offset))
                    queued_preview_offset += len(live_chunk) / (start.sample_rate * 2)
                    del pending[:chunk_bytes]
            elif message.get("text") == "stop":
                stopped = True
                if _can_finalize_from_full_audio(pcm_size):
                    # The authoritative full-audio pass will cover the entire
                    # recording. Give only the in-flight preview a short chance
                    # to finish, then stop waiting for stale preview calls.
                    if fallback_active:
                        if pending:
                            tail = _gate_live_pcm(
                                bytes(pending), settings.live_voice_rms_threshold
                            )
                            raw_file.write(tail)
                            await queue.put((tail, queued_preview_offset))
                        pending.clear()
                    else:
                        if pending:
                            raw_file.write(
                                _gate_live_pcm(
                                    bytes(pending), settings.live_voice_rms_threshold
                                )
                            )
                        pending.clear()
                        while not queue.empty():
                            queue.get_nowait()
                    await queue.put(None)
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(workers_gather),
                            timeout=settings.live_stop_preview_grace_seconds,
                        )
                    except TimeoutError:
                        for task in workers:
                            task.cancel()
                        await workers_gather
                else:
                    # Preserve the old drain behavior when the full pass is
                    # disabled or the recording is too large for inline input.
                    if pending:
                        tail = _gate_live_pcm(
                            bytes(pending), settings.live_voice_rms_threshold
                        )
                        raw_file.write(tail)
                        await queue.put((tail, queued_preview_offset))
                        pending.clear()
                    await queue.put(None)
                    await workers_gather
                if translation_tasks:
                    try:
                        await asyncio.wait_for(
                            asyncio.gather(*translation_tasks, return_exceptions=True),
                            timeout=min(3.0, settings.live_stop_preview_grace_seconds),
                        )
                    except TimeoutError:
                        for task in list(translation_tasks):
                            task.cancel()
                break

        if live_connect is not None and live_entered:
            await live_connect.__aexit__(None, None, None)
            live_connect = None
            live_entered = False

        path = settings.data_dir / "audio" / record.audio_filename
        record.processing_stage = ProcessingStage.saving_audio
        await save_record(record)
        raw_file.close()
        raw_file = None
        await asyncio.to_thread(_raw_to_wav, raw_path, path, start.sample_rate)
        await asyncio.to_thread(raw_path.unlink)
        raw_path = None
        record.duration_seconds = pcm_size / (start.sample_rate * 2)
        await save_record(record)
        _start_background_finalization(record, path)
        await websocket.send_json({"type": "finalizing", "id": record.id})
        await websocket.close()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        if record:
            record.status = JobStatus.failed
            record.processing_stage = None
            record.error = str(exc)
            await save_record(record)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if raw_file:
            raw_file.close()
        if raw_path and raw_path.exists():
            with suppress(OSError):
                raw_path.unlink()
        for task in workers:
            if not task.done():
                task.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)
        for task in list(translation_tasks):
            if not task.done():
                task.cancel()
        if translation_tasks:
            await asyncio.gather(*translation_tasks, return_exceptions=True)
        if live_connect is not None and live_entered:
            await live_connect.__aexit__(None, None, None)
        if record and not stopped and record.status == JobStatus.processing:
            record.status = JobStatus.failed
            record.processing_stage = None
            record.error = "Live connection closed before the session was stopped"
            await save_record(record)
