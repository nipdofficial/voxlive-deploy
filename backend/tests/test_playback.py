import asyncio
import time
from types import SimpleNamespace

from app.api.routes import meetings, transcribe
from app.models.schemas import (
    JobStatus,
    Language,
    PlaybackStatus,
    ProcessingStage,
    SessionType,
    TranscriptRecord,
    TranscriptSegment,
)
from app.services.meeting_service import MeetingSession


def test_meeting_upload_processing_becomes_ready(monkeypatch, tmp_path) -> None:
    path = tmp_path / "meeting.mp3"
    path.write_bytes(b"audio")
    record = TranscriptRecord(
        id="upload-meeting",
        title="Prepared meeting",
        language=Language.mixed,
        session_type=SessionType.meeting,
        start_mode=SessionType.upload,
        duration_seconds=8,
    )

    class Gemini:
        async def transcribe_file(self, *_args, **kwargs):
            assert kwargs["model"] == "structured-model"
            assert kwargs["audio_duration_seconds"] == 8
            return [TranscriptSegment(start=1.25, end=2.5, text="Hello")]

        async def translate_segments(self, segments, target):
            assert target == Language.tamil
            return ["வணக்கம்" for _ in segments]

    async def save(value):
        return value

    monkeypatch.setattr(transcribe, "GeminiService", Gemini)
    monkeypatch.setattr(transcribe, "save_record", save)
    monkeypatch.setattr(
        transcribe,
        "get_settings",
        lambda: SimpleNamespace(
            auto_translate=True,
            target_language=Language.tamil,
            gemini_text_model="structured-model",
            live_voice_rms_threshold=180,
            live_silence_rms_threshold=20,
        ),
    )

    asyncio.run(transcribe._process(record, path, "audio/mpeg"))

    assert record.status == JobStatus.completed
    assert record.processing_stage == ProcessingStage.ready
    assert record.playback_status == PlaybackStatus.ready
    assert record.segments[0].segment_id == "upload-meeting:1"
    assert record.segments[0].start == 1.25
    assert record.segments[0].translated_text == "வணக்கம்"


def test_upload_playback_pause_resume_uses_monotonic_clock(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Prepared",
        language=Language.english,
        session_type=SessionType.meeting,
        start_mode=SessionType.upload,
        status=JobStatus.completed,
        duration_seconds=60,
        playback_status=PlaybackStatus.playing,
    )
    session = MeetingSession("ABCDEFGH", "secret", record, Language.english)
    session.started = True
    session.playback_status = PlaybackStatus.playing
    session.playback_anchor_monotonic = time.monotonic() - 2

    async def save(value):
        return value

    monkeypatch.setattr("app.services.meeting_service.save_record", save)

    asyncio.run(session.control_playback("pause"))
    paused = session.playback_position_seconds
    assert 1.8 <= paused <= 2.5
    assert session.playback_status == PlaybackStatus.paused

    asyncio.run(session.control_playback("resume"))
    assert session.playback_status == PlaybackStatus.playing
    assert session.current_playback_position() >= paused


def test_late_upload_attendee_receives_only_elapsed_segments(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Prepared",
        language=Language.english,
        session_type=SessionType.meeting,
        start_mode=SessionType.upload,
        status=JobStatus.completed,
        duration_seconds=30,
        segments=[
            TranscriptSegment(segment_id="one", sequence=1, is_final=True, start=1, end=2, text="One", translated_text="ஒன்று"),
            TranscriptSegment(segment_id="two", sequence=2, is_final=True, start=12, end=13, text="Two", translated_text="இரண்டு"),
        ],
    )
    session = MeetingSession("ABCDEFGH", "secret", record, Language.english)
    session.playback_status = PlaybackStatus.paused
    session.playback_position_seconds = 5
    participant = SimpleNamespace(identity="guest", display_name="Guest")
    monkeypatch.setattr(meetings, "get_settings", lambda: SimpleNamespace(livekit_url="wss://livekit"))

    connection = meetings._connection(session, participant, "token", is_host=False)

    assert [item.segment_id for item in connection.segments] == ["one"]
