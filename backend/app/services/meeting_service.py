import asyncio
import io
import json
import logging
import secrets
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.api.routes.history import save_record
from app.core.config import get_settings
from app.models.schemas import (
    JobStatus,
    Language,
    MeetingParticipant,
    ProcessingStage,
    TranscriptRecord,
    TranscriptSegment,
)
from app.services.audio_service import pcm_rms
from app.services.diarization_service import diarize_file, merge_transcript_and_speakers
from app.services.gemini_service import GeminiService

SAMPLE_RATE = 16_000
TRANSCRIPT_TOPIC = "transcript.segment"
logger = logging.getLogger(__name__)


def generate_room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def normalize_display_name(value: str) -> str:
    name = " ".join(value.strip().split())
    if not name:
        raise ValueError("Display name is required")
    return name[:80]


def participant_identity() -> str:
    return f"user-{secrets.token_urlsafe(9)}"


def pcm_wav_bytes(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return output.getvalue()


def label_segments(
    segments: list[TranscriptSegment],
    *,
    identity: str,
    display_name: str,
    offset: float,
) -> list[TranscriptSegment]:
    return [
        item.model_copy(
            update={
                "start": item.start + offset,
                "end": item.end + offset,
                "speaker": display_name,
                "participant_identity": identity,
            }
        )
        for item in segments
    ]


def merge_room_segments(states: list["TrackState"]) -> list[TranscriptSegment]:
    return sorted(
        (segment for state in states for segment in state.final_segments),
        key=lambda item: (item.start, item.end, item.participant_identity or ""),
    )


@dataclass
class TrackState:
    identity: str
    display_name: str
    shared_mic: bool
    start_offset: float
    pcm: bytearray = field(default_factory=bytearray)
    pcm_size: int = 0
    raw_path: Path | None = None
    raw_file: Any = None
    pending: bytearray = field(default_factory=bytearray)
    queued_bytes: int = 0
    first_chunk: bool = True
    preview_segments: list[TranscriptSegment] = field(default_factory=list)
    final_segments: list[TranscriptSegment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    queue: asyncio.Queue[tuple[bytes, float, float] | None] = field(
        default_factory=lambda: asyncio.Queue(maxsize=4)
    )
    worker: asyncio.Task[None] | None = None
    capture_tasks: set[asyncio.Task[None]] = field(default_factory=set)

    @property
    def duration(self) -> float:
        return (self.pcm_size + len(self.pcm)) / (SAMPLE_RATE * 2)

    def append_audio(self, data: bytes) -> None:
        if self.raw_file is not None:
            self.raw_file.write(data)
            self.pcm_size += len(data)
        else:
            self.pcm.extend(data)


def raw_pcm_to_wav(raw_path: Path, wav_path: Path) -> None:
    with raw_path.open("rb") as source, wave.open(str(wav_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        while chunk := source.read(1024 * 1024):
            output.writeframes(chunk)


class MeetingSession:
    def __init__(
        self,
        code: str,
        host_secret: str,
        record: TranscriptRecord,
        language: Language,
        title: str = "Online meeting",
        max_participants: int = 0,
        scheduled_start: datetime | None = None,
        scheduled_end: datetime | None = None,
    ) -> None:
        self.code = code
        self.room_name = f"helascribe-{code.lower()}"
        self.host_secret = host_secret
        self.record = record
        self.language = language
        self.title = title
        self.max_participants = max_participants
        self.scheduled_start = scheduled_start
        self.scheduled_end = scheduled_end
        self.started_at = time.monotonic()
        self.created_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        self.started = False
        self.states: dict[str, TrackState] = {}
        self.room: Any = None
        self.stop_event = asyncio.Event()
        self.ready_event = asyncio.Event()
        self.start_error: str | None = None
        self.task: asyncio.Task[None] | None = None
        self.ending = False
        # Translation is deliberately decoupled from the live transcription
        # worker. The source is retained privately until its Tamil translation
        # is ready, then one complete line is sent to every client.
        self.translation_tasks: set[asyncio.Task[None]] = set()
        # Keep live translation requests ordered. Sending one Gemini request
        # for every overlapping audio chunk at once can trigger throttling and
        # make Sinhala source captions appear without their Tamil updates.
        self.translation_lock = asyncio.Lock()
        self.next_segment_sequence = 1

    @property
    def participant_count(self) -> int:
        return len(self.record.participants)

    @property
    def status(self) -> str:
        if self.ending:
            return "ended"
        if self.started:
            return "live"
        if self.scheduled_start and self.scheduled_start > datetime.now(timezone.utc):
            return "upcoming"
        return "ready"

    def add_participant(
        self, identity: str, display_name: str, shared_mic: bool
    ) -> MeetingParticipant:
        if self.max_participants > 0 and self.participant_count >= self.max_participants:
            raise ValueError(
                f"Session is full ({self.max_participants} participants maximum)"
            )
        participant = MeetingParticipant(
            identity=identity,
            display_name=display_name,
            shared_mic=shared_mic,
        )
        self.record.participants.append(participant)
        self.record.diarization = self.record.diarization or shared_mic
        return participant

    def _canonical_segment(self, segment: TranscriptSegment) -> TranscriptSegment:
        """Assign one stable identity before a segment is ever broadcast."""
        sequence = self.next_segment_sequence
        self.next_segment_sequence += 1
        return segment.model_copy(
            update={
                "segment_id": f"{self.record.id}:{sequence}",
                "sequence": sequence,
                "is_final": False,
            }
        )

    async def start(self) -> None:
        if self.started:
            return
        self.task = asyncio.create_task(self._run())
        try:
            await asyncio.wait_for(self.ready_event.wait(), timeout=12)
        except asyncio.TimeoutError as exc:
            self.stop_event.set()
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            raise RuntimeError("The live transcription service did not become ready") from exc
        if self.start_error:
            raise RuntimeError(self.start_error)

    async def _run(self) -> None:
        try:
            from livekit import api, rtc

            settings = get_settings()
            token = (
                api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
                .with_identity(f"transcriber-{self.code.lower()}")
                .with_name("HelaScribe Transcriber")
                .with_ttl(timedelta(minutes=settings.livekit_token_minutes))
                .with_grants(
                    api.VideoGrants(
                        room_join=True,
                        room=self.room_name,
                        can_publish=False,
                        can_subscribe=True,
                        can_publish_data=True,
                        hidden=True,
                    )
                )
            ).to_jwt()
            room = rtc.Room()
            self.room = room

            @room.on("track_subscribed")
            def on_track_subscribed(track, _publication, participant) -> None:
                if track.kind != rtc.TrackKind.KIND_AUDIO or self.ending:
                    return
                metadata = self._participant_metadata(participant)
                state = self._state_for(
                    participant.identity,
                    participant.name or participant.identity,
                    bool(metadata.get("shared_mic", False)),
                )
                logger.info(
                    "meeting_audio_track_subscribed meeting_id=%s participant=%s",
                    self.record.id,
                    participant.identity,
                )
                self._pad_reconnect_gap(state)
                task = asyncio.create_task(self._consume_track(track, state))
                state.capture_tasks.add(task)
                task.add_done_callback(state.capture_tasks.discard)

            await room.connect(settings.livekit_url, token)
            # Do not return success to the organizer until this hidden
            # participant is actually in the room and able to subscribe to
            # the organizer microphone. This removes a start-up race where
            # speech could begin before the transcriber joined.
            self.started = True
            self.started_at = time.monotonic()
            self.ready_event.set()
            logger.info("meeting_transcriber_ready meeting_id=%s room=%s", self.record.id, self.room_name)
            self.record.status = JobStatus.processing
            self.record.processing_stage = ProcessingStage.recording
            await save_record(self.record)
            await self.stop_event.wait()
            await self._finalize()
            await room.disconnect()
        except Exception as exc:
            self.start_error = f"Meeting worker failed: {exc}"
            self.ready_event.set()
            self.record.status = JobStatus.failed
            self.record.processing_stage = None
            self.record.error = self.start_error
            await save_record(self.record)
        finally:
            for state in self.states.values():
                if state.raw_file is not None:
                    state.raw_file.close()
                    state.raw_file = None
                if state.raw_path and state.raw_path.exists():
                    try:
                        state.raw_path.unlink()
                    except OSError:
                        pass

    @staticmethod
    def _participant_metadata(participant: Any) -> dict[str, Any]:
        try:
            return json.loads(participant.metadata or "{}")
        except (TypeError, json.JSONDecodeError):
            return {}

    def _state_for(
        self, identity: str, display_name: str, shared_mic: bool
    ) -> TrackState:
        state = self.states.get(identity)
        if state:
            return state
        state = TrackState(
            identity=identity,
            display_name=display_name,
            shared_mic=shared_mic,
            start_offset=max(0.0, time.monotonic() - self.started_at),
        )
        settings = get_settings()
        safe_identity = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in identity
        )
        state.raw_path = settings.data_dir / "audio" / f"{self.record.id}-{safe_identity}.pcm.part"
        state.raw_file = state.raw_path.open("wb")
        state.queue = asyncio.Queue(
            maxsize=max(2, getattr(settings, "live_preview_queue_size", 4))
        )
        state.worker = asyncio.create_task(self._transcribe_chunks(state))
        self.states[identity] = state
        return state

    def _pad_reconnect_gap(self, state: TrackState) -> None:
        target_duration = max(0.0, time.monotonic() - self.started_at - state.start_offset)
        missing = int((target_duration - state.duration) * SAMPLE_RATE * 2)
        if missing > 0:
            silence = b"\0" * (missing - (missing % 2))
            state.append_audio(silence)
            state.pending.extend(silence)

    async def _consume_track(self, track: Any, state: TrackState) -> None:
        from livekit import rtc

        settings = get_settings()
        chunk_bytes = int(settings.live_chunk_seconds * SAMPLE_RATE * 2)
        overlap_bytes = min(
            chunk_bytes // 2,
            int(settings.live_chunk_overlap_seconds * SAMPLE_RATE * 2),
        )
        advance_bytes = chunk_bytes - overlap_bytes
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        try:
            async for event in stream:
                if self.ending:
                    break
                await self.ingest_pcm(state, bytes(event.frame.data))
        except Exception as exc:
            state.warnings.append(f"{state.display_name} audio track failed: {exc}")
        finally:
            await stream.aclose()

    async def ingest_pcm(self, state: TrackState, data: bytes) -> None:
        """Accept normalized 16 kHz mono PCM from LiveKit or the organizer socket."""
        if self.ending or not data:
            return
        settings = get_settings()
        chunk_bytes = int(settings.live_chunk_seconds * SAMPLE_RATE * 2)
        overlap_bytes = min(
            chunk_bytes // 2,
            int(settings.live_chunk_overlap_seconds * SAMPLE_RATE * 2),
        )
        advance_bytes = chunk_bytes - overlap_bytes
        state.append_audio(data)
        state.pending.extend(data)
        while len(state.pending) >= chunk_bytes:
            chunk = bytes(state.pending[:chunk_bytes])
            offset = state.start_offset + state.queued_bytes / (SAMPLE_RATE * 2)
            commit_after = 0.0 if state.first_chunk else offset + settings.live_chunk_overlap_seconds
            await state.queue.put((chunk, offset, commit_after))
            del state.pending[:advance_bytes]
            state.queued_bytes += advance_bytes
            state.first_chunk = False

    async def _transcribe_chunks(self, state: TrackState) -> None:
        gemini = GeminiService()
        settings = get_settings()
        while True:
            queued = await state.queue.get()
            if queued is None:
                return
            chunk, offset, commit_after = queued
            if pcm_rms(chunk) < settings.live_silence_rms_threshold:
                continue
            try:
                raw = await gemini.transcribe_file(
                    pcm_wav_bytes(chunk),
                    "audio/wav",
                    self.language,
                    model=settings.gemini_batch_model,
                    audio_duration_seconds=len(chunk) / (SAMPLE_RATE * 2),
                    request_timeout_seconds=settings.gemini_live_timeout_seconds,
                    # Do not hold the live caption on the translation call.
                    # The Tamil update is published by a separate task below.
                    translate_to=None,
                    verify_mixed_language=False,
                    use_structured_mixed_model=False,
                )
                labeled = label_segments(
                    raw,
                    identity=state.identity,
                    display_name=state.display_name,
                    offset=offset,
                )
                published: list[TranscriptSegment] = []
                for segment in labeled:
                    if (segment.start + segment.end) / 2 < commit_after:
                        continue
                    segment = self._canonical_segment(segment)
                    published.append(segment)
                    state.preview_segments.append(segment)
                    logger.info(
                        "meeting_source_ready meeting_id=%s segment_id=%s sequence=%s language=%s",
                        self.record.id,
                        segment.segment_id,
                        segment.sequence,
                        segment.detected_language.value if segment.detected_language else "Unknown",
                    )
                if published:
                    translation_task = asyncio.create_task(
                        self._translate_preview_segments(published)
                    )
                    self.translation_tasks.add(translation_task)
                    translation_task.add_done_callback(self.translation_tasks.discard)
                await save_record(self.record)
            except Exception as exc:
                state.warnings.append(f"{state.display_name} preview failed: {exc}")

    async def _broadcast_segment(self, segment: TranscriptSegment) -> None:
        if not self.room:
            return
        if not segment.speaker:
            segment = segment.model_copy(update={"speaker": "Speaker"})
        payload = json.dumps(
            {"type": "transcript", "segment": segment.model_dump(mode="json")},
            ensure_ascii=False,
        ).encode("utf-8")
        await self.room.local_participant.publish_data(
            payload, reliable=True, topic=TRANSCRIPT_TOPIC
        )

    async def _broadcast_translation(self, segment: TranscriptSegment) -> None:
        if not self.room or not segment.translated_text:
            return
        payload = json.dumps(
            {"type": "translation", "segment": segment.model_dump(mode="json")},
            ensure_ascii=False,
        ).encode("utf-8")
        await self.room.local_participant.publish_data(
            payload, reliable=True, topic=TRANSCRIPT_TOPIC
        )

    async def _translate_preview_segments(
        self, segments: list[TranscriptSegment]
    ) -> None:
        """Attach Tamil to already-published live segments without blocking them."""
        try:
            started = time.perf_counter()
            async with self.translation_lock:
                translator = GeminiService()
                try:
                    translations = await translator.translate_segments(
                        segments, get_settings().target_language
                    )
                except Exception:
                    # A batch response should not discard every line when a
                    # provider response is malformed or only one line fails.
                    translations = []
                    for segment in segments:
                        try:
                            result = await translator.translate_segments(
                                [segment], get_settings().target_language
                            )
                            translations.append(result[0] if result else "")
                        except Exception:
                            translations.append("")
            for source, translated in zip(segments, translations, strict=True):
                if not translated:
                    continue
                updated = source.model_copy(
                    update={"translated_text": translated, "is_final": True}
                )
                for index, saved in enumerate(self.record.segments):
                    if (
                        saved.segment_id == source.segment_id
                        if source.segment_id
                        else saved.participant_identity == source.participant_identity
                        and saved.start == source.start
                        and saved.end == source.end
                        and saved.text == source.text
                    ):
                        self.record.segments[index] = updated
                        break
                for state in self.states.values():
                    for index, saved in enumerate(state.preview_segments):
                        if (
                            saved.segment_id == source.segment_id
                            if source.segment_id
                            else saved.start == source.start
                            and saved.end == source.end
                            and saved.text == source.text
                        ):
                            state.preview_segments[index] = updated
                            break
                # A client must never have to combine a source event with a
                # later translation event. Publish a single complete result so
                # organizer and attendee render exactly the same Tamil/source
                # pair as one live line.
                if not any(saved.segment_id == source.segment_id for saved in self.record.segments):
                    self.record.segments.append(updated)
                await self._broadcast_translation(updated)
                logger.info(
                    "meeting_translation_published meeting_id=%s segment_id=%s sequence=%s translation_ms=%.1f",
                    self.record.id,
                    updated.segment_id,
                    updated.sequence,
                    (time.perf_counter() - started) * 1000,
                )
            await save_record(self.record)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Source captions remain useful if a translation request is slow
            # or temporarily unavailable; finalization retries translation.
            identities = {segment.participant_identity for segment in segments}
            for state in self.states.values():
                if state.identity in identities:
                    state.warnings.append(
                        f"{state.display_name} live translation delayed: {exc}"
                    )

    async def end(self) -> None:
        if self.ending:
            return
        self.ending = True
        self.record.status = JobStatus.processing
        self.record.processing_stage = ProcessingStage.saving_audio
        await save_record(self.record)
        self.stop_event.set()

    async def _finalize(self) -> None:
        settings = get_settings()
        self.record.processing_stage = ProcessingStage.transcribing
        await save_record(self.record)
        for state in self.states.values():
            if state.capture_tasks:
                for task in tuple(state.capture_tasks):
                    task.cancel()
                await asyncio.gather(*state.capture_tasks, return_exceptions=True)
            if state.raw_file is not None:
                state.raw_file.close()
                state.raw_file = None
            if state.pending:
                offset = state.start_offset + state.queued_bytes / (SAMPLE_RATE * 2)
                commit_after = (
                    0.0
                    if state.first_chunk
                    else offset + settings.live_chunk_overlap_seconds
                )
                await state.queue.put((bytes(state.pending), offset, commit_after))
                state.pending.clear()
            await state.queue.put(None)
            if state.worker:
                await state.worker
        if self.translation_tasks:
            await asyncio.gather(*tuple(self.translation_tasks), return_exceptions=True)
        for state in self.states.values():
            try:
                await self._finalize_state(state)
            except Exception as exc:
                state.final_segments = state.preview_segments
                state.warnings.append(
                    f"{state.display_name} finalization failed; preview retained: {exc}"
                )

        self.record.segments = merge_room_segments(list(self.states.values()))
        self.record.transcript = "\n".join(
            (f"{item.speaker}: " if item.speaker else "") + item.text
            + (f"\nTranslation: {item.translated_text}" if item.translated_text and item.translated_text != item.text else "")
            for item in self.record.segments
        )
        self.record.duration_seconds = max(
            (item.end for item in self.record.segments), default=0.0
        )
        warnings = [warning for state in self.states.values() for warning in state.warnings]
        self.record.error = "; ".join(warnings) or None
        self.record.status = JobStatus.completed
        self.record.processing_stage = None
        await save_record(self.record)

    async def _finalize_state(self, state: TrackState) -> None:
        # The translated, canonical live sequence is the authoritative meeting
        # record. Keeping it prevents the historical file from disagreeing
        # with what both organizer and attendees saw live. Fall back to the
        # full-audio pass only when live translation did not complete.
        if state.preview_segments and all(
            segment.is_final and segment.translated_text
            for segment in state.preview_segments
        ):
            state.final_segments = state.preview_segments
            return
        if state.duration <= 0:
            state.final_segments = state.preview_segments
            return
        settings = get_settings()
        if self.record.processing_stage != ProcessingStage.transcribing:
            self.record.processing_stage = ProcessingStage.transcribing
            await save_record(self.record)
        safe_identity = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in state.identity
        )
        filename = f"{self.record.id}-{safe_identity}.wav"
        path = settings.data_dir / "audio" / filename
        if state.raw_path and state.raw_path.is_file():
            await asyncio.to_thread(raw_pcm_to_wav, state.raw_path, path)
            await asyncio.to_thread(state.raw_path.unlink)
            state.raw_path = None
            if path.stat().st_size > settings.max_upload_mb * 1024 * 1024:
                state.final_segments = state.preview_segments
                state.warnings.append(
                    f"{state.display_name} full-session pass skipped above "
                    f"{settings.max_upload_mb} MB; live previews retained"
                )
                self.record.participant_audio[state.identity] = filename
                return
            audio = await asyncio.to_thread(path.read_bytes)
            pcm_for_rms = audio[44:]
        else:
            pcm_for_rms = bytes(state.pcm)
            audio = pcm_wav_bytes(pcm_for_rms)
            await asyncio.to_thread(path.write_bytes, audio)
        self.record.participant_audio[state.identity] = filename
        try:
            if pcm_rms(pcm_for_rms) < settings.live_silence_rms_threshold:
                final: list[TranscriptSegment] = []
            else:
                final = await GeminiService().transcribe_file(
                    audio,
                    "audio/wav",
                    self.language,
                    model=settings.gemini_batch_model,
                    include_speakers=state.shared_mic,
                    audio_duration_seconds=state.duration,
                    translate_to=settings.target_language,
                )
            if state.shared_mic and final:
                self.record.processing_stage = ProcessingStage.diarizing
                await save_record(self.record)
                try:
                    turns = await diarize_file(str(path))
                    final = merge_transcript_and_speakers(final, turns)
                except Exception as exc:
                    state.warnings.append(
                        f"{state.display_name} diarization unavailable: {exc}"
                    )
            state.final_segments = []
            for segment in final:
                nested_speaker = segment.speaker if state.shared_mic else None
                speaker = (
                    f"{state.display_name} / {nested_speaker}"
                    if nested_speaker
                    else state.display_name
                )
                state.final_segments.append(
                    segment.model_copy(
                        update={
                            "start": segment.start + state.start_offset,
                            "end": segment.end + state.start_offset,
                            "speaker": speaker,
                            "participant_identity": state.identity,
                        }
                    )
                )
        except Exception as exc:
            state.final_segments = state.preview_segments
            state.warnings.append(
                f"{state.display_name} final pass unavailable; preview retained: {exc}"
            )


class MeetingRegistry:
    def __init__(self) -> None:
        self.sessions: dict[str, MeetingSession] = {}
        self.lock = asyncio.Lock()

    async def create(
        self,
        record: TranscriptRecord,
        language: Language,
        title: str = "Online meeting",
        max_participants: int = 0,
        scheduled_start: datetime | None = None,
        scheduled_end: datetime | None = None,
    ) -> MeetingSession:
        async with self.lock:
            code = generate_room_code()
            while code in self.sessions:
                code = generate_room_code()
            session = MeetingSession(
                code,
                secrets.token_urlsafe(32),
                record,
                language,
                title=title,
                max_participants=max_participants,
                scheduled_start=scheduled_start,
                scheduled_end=scheduled_end,
            )
            self.sessions[code] = session
        return session

    def get(self, code: str) -> MeetingSession | None:
        return self.sessions.get(code.strip().upper())


meeting_registry = MeetingRegistry()


def create_join_token(
    session: MeetingSession,
    identity: str,
    display_name: str,
    shared_mic: bool,
    *,
    is_host: bool = True,
) -> str:
    from livekit import api

    settings = get_settings()
    metadata = json.dumps({"shared_mic": shared_mic if is_host else False})
    return (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(display_name)
        .with_metadata(metadata)
        .with_ttl(timedelta(minutes=settings.livekit_token_minutes))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=session.room_name,
                can_publish=is_host,
                can_subscribe=True,
                can_publish_data=is_host,
                can_publish_sources=["microphone"] if is_host else [],
            )
        )
    ).to_jwt()


def require_livekit_settings() -> None:
    settings = get_settings()
    if not all(
        (settings.livekit_url, settings.livekit_api_key, settings.livekit_api_secret)
    ):
        raise RuntimeError("LiveKit Meeting mode is not configured")
