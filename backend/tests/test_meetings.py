import asyncio
import json
import re
import wave
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.schemas import TranscriptSegment
from app.services.meeting_service import (
    TrackState,
    generate_room_code,
    label_segments,
    merge_room_segments,
    normalize_display_name,
    raw_pcm_to_wav,
)


def test_room_code_is_short_unambiguous_and_random() -> None:
    codes = {generate_room_code() for _ in range(100)}
    assert len(codes) == 100
    assert all(re.fullmatch(r"[A-HJ-NP-Z2-9]{8}", code) for code in codes)


def test_display_name_is_normalized() -> None:
    assert normalize_display_name("  Anu   Kumar  ") == "Anu Kumar"


def test_raw_pcm_is_written_as_valid_wav(tmp_path) -> None:
    raw_path = tmp_path / "audio.pcm"
    wav_path = tmp_path / "audio.wav"
    pcm = b"\x01\x02" * 160
    raw_path.write_bytes(pcm)

    raw_pcm_to_wav(raw_path, wav_path)

    with wave.open(str(wav_path), "rb") as audio:
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getframerate() == 16_000
        assert audio.readframes(160) == pcm


def test_meeting_chunk_settings_are_available() -> None:
    from app.core.config import Settings

    settings = Settings(_env_file=None)
    assert settings.live_chunk_seconds > settings.live_chunk_overlap_seconds > 0


def test_participant_label_and_room_offset_are_preserved() -> None:
    segment = TranscriptSegment(start=0.25, end=1.5, text="hello")
    result = label_segments(
        [segment], identity="user-1", display_name="Anu", offset=12.0
    )[0]
    assert result.start == 12.25
    assert result.end == 13.5
    assert result.speaker == "Anu"
    assert result.participant_identity == "user-1"


def test_room_merge_orders_independent_participant_tracks() -> None:
    first = TrackState("one", "One", False, 0)
    second = TrackState("two", "Two", False, 0)
    first.final_segments = [
        TranscriptSegment(
            start=3,
            end=4,
            text="later",
            speaker="One",
            participant_identity="one",
        )
    ]
    second.final_segments = [
        TranscriptSegment(
            start=1,
            end=2,
            text="earlier",
            speaker="Two",
            participant_identity="two",
        )
    ]
    assert [item.text for item in merge_room_segments([first, second])] == [
        "earlier",
        "later",
    ]


def test_reconnect_gap_keeps_room_timeline(monkeypatch) -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Meeting",
        language=Language.english,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.english)
    session.started_at = 100.0
    state = TrackState("one", "One", False, 1.0)
    state.pcm.extend(b"\0\0" * 16_000)  # one second captured
    monkeypatch.setattr(meeting_service.time, "monotonic", lambda: 104.0)

    session._pad_reconnect_gap(state)

    assert state.duration == 3.0
    assert len(state.pending) == 2 * 16_000 * 2


def test_canonical_live_segments_have_stable_ordered_ids() -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        id="meeting-1", title="Meeting", language=Language.sinhala, session_type=SessionType.meeting
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.sinhala)

    first = session._canonical_segment(TranscriptSegment(start=0, end=1, text="පළමුව"))
    second = session._canonical_segment(TranscriptSegment(start=1, end=2, text="දෙවැනි"))

    assert (first.segment_id, first.sequence, first.is_final) == ("meeting-1:1", 1, False)
    assert (second.segment_id, second.sequence, second.is_final) == ("meeting-1:2", 2, False)


def test_finalization_preserves_canonical_live_tamil_segments() -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(title="Meeting", language=Language.sinhala, session_type=SessionType.meeting)
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.sinhala)
    state = TrackState("host", "Anu", False, 0)
    state.preview_segments = [
        TranscriptSegment(
            segment_id="record:1", sequence=1, is_final=True, start=0, end=1,
            text="සිංහල", translated_text="தமிழ்",
        )
    ]

    asyncio.run(session._finalize_state(state))

    assert state.final_segments == state.preview_segments


def test_join_connection_replays_only_finalized_canonical_segments(monkeypatch) -> None:
    from app.api.routes import meetings
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(title="Meeting", language=Language.sinhala, session_type=SessionType.meeting)
    record.segments = [
        TranscriptSegment(segment_id="record:1", sequence=1, is_final=True, start=0, end=1, text="සිංහල", translated_text="தமிழ்"),
        TranscriptSegment(segment_id="record:2", sequence=2, is_final=False, start=1, end=2, text="pending"),
    ]
    session = SimpleNamespace(
        code="ABCDEFGH", record=record, host_secret="secret", language=Language.sinhala
    )
    participant = SimpleNamespace(identity="guest", display_name="Guest")
    monkeypatch.setattr(meetings, "get_settings", lambda: SimpleNamespace(livekit_url="wss://livekit"))

    connection = meetings._connection(session, participant, "token", is_host=False)

    assert [segment.segment_id for segment in connection.segments] == ["record:1"]


def test_live_translation_updates_saved_segment_and_broadcasts_delta(monkeypatch) -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Sinhala meeting",
        language=Language.sinhala,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.sinhala)
    segment = TranscriptSegment(
        start=0,
        end=2,
        text="සිංහල වාක්‍යය",
        speaker="Anu",
        participant_identity="user-1",
    )
    state = TrackState("user-1", "Anu", False, 0)
    state.preview_segments = [segment]
    record.segments = [segment]
    session.states[state.identity] = state

    class FakeParticipant:
        def __init__(self) -> None:
            self.payloads: list[dict] = []

        async def publish_data(self, payload, *, reliable, topic):
            self.payloads.append(json.loads(payload.decode("utf-8")))

    class FakeGemini:
        async def translate_segments(self, segments, target_language):
            assert target_language == Language.tamil
            return ["தமிழ் மொழிபெயர்ப்பு"]

    async def ignore_save(_record):
        return _record

    participant = FakeParticipant()
    session.room = SimpleNamespace(local_participant=participant)
    monkeypatch.setattr(meeting_service, "GeminiService", FakeGemini)
    monkeypatch.setattr(
        meeting_service,
        "get_settings",
        lambda: SimpleNamespace(target_language=Language.tamil),
    )
    monkeypatch.setattr(meeting_service, "save_record", ignore_save)

    asyncio.run(session._translate_preview_segments([segment]))

    assert record.segments[0].translated_text == "தமிழ் மொழிபெயர்ப்பு"
    assert state.preview_segments[0].translated_text == "தமிழ் மொழிபெயர்ப்பு"
    assert participant.payloads == [
        {"type": "translation", "segment": record.segments[0].model_dump(mode="json")}
    ]


def test_live_pipeline_issue_is_broadcast_and_recovery_clears_it(monkeypatch) -> None:
    from app.services.meeting_service import MeetingSession
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Sinhala meeting",
        language=Language.sinhala,
        session_type=SessionType.meeting,
    )
    session = MeetingSession("ABCDEFGH", "secret", record, Language.sinhala)

    class FakeParticipant:
        def __init__(self) -> None:
            self.payloads: list[dict] = []

        async def publish_data(self, payload, *, reliable, topic):
            self.payloads.append(json.loads(payload.decode("utf-8")))

    participant = FakeParticipant()
    session.room = SimpleNamespace(local_participant=participant)

    async def exercise() -> None:
        await session._set_live_issue("transcription", "VoxLive could not transcribe this chunk")
        await session._set_live_issue("transcription", "VoxLive could not transcribe this chunk")
        await session._set_live_issue("transcription", None)

    asyncio.run(exercise())

    assert record.error is None
    assert [item["type"] for item in participant.payloads] == ["warning", "recovered"]
    assert participant.payloads[0]["message"] == "VoxLive could not transcribe this chunk"


def test_live_translation_failure_is_not_silently_swallowed(monkeypatch) -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Sinhala meeting",
        language=Language.sinhala,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.sinhala)
    segment = TranscriptSegment(start=0, end=2, text="සිංහල", participant_identity="speaker")

    class FakeParticipant:
        def __init__(self) -> None:
            self.payloads: list[dict] = []

        async def publish_data(self, payload, *, reliable, topic):
            self.payloads.append(json.loads(payload.decode("utf-8")))

    class FailingTranslator:
        async def translate_segments(self, _segments, _target_language):
            raise RuntimeError("temporary translator failure")

    async def ignore_save(_record):
        return _record

    participant = FakeParticipant()
    session.room = SimpleNamespace(local_participant=participant)
    monkeypatch.setattr(meeting_service, "GeminiService", FailingTranslator)
    monkeypatch.setattr(meeting_service, "save_record", ignore_save)
    monkeypatch.setattr(
        meeting_service,
        "get_settings",
        lambda: SimpleNamespace(target_language=Language.tamil),
    )

    asyncio.run(session._translate_preview_segments([segment]))

    assert "could not translate" in record.error
    assert participant.payloads[-1]["type"] == "warning"
    assert "translation" in participant.payloads[-1]["message"].lower()


def test_end_is_idempotent(monkeypatch) -> None:
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    record = TranscriptRecord(
        title="Meeting",
        language=Language.english,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.english)

    async def ignore_save(_record):
        return _record

    monkeypatch.setattr(meeting_service, "save_record", ignore_save)
    asyncio.run(session.end())
    asyncio.run(session.end())
    assert session.ending is True
    assert session.stop_event.is_set()


def test_participant_token_is_room_scoped_and_microphone_only(monkeypatch) -> None:
    api = pytest.importorskip("livekit.api")
    from app.services import meeting_service
    from app.models.schemas import Language, SessionType, TranscriptRecord

    monkeypatch.setattr(
        meeting_service,
        "get_settings",
        lambda: SimpleNamespace(
            livekit_api_key="test-key",
            livekit_api_secret="test-secret-long-enough-for-jwt",
            livekit_token_minutes=10,
        ),
    )
    record = TranscriptRecord(
        title="Meeting",
        language=Language.english,
        session_type=SessionType.meeting,
    )
    session = meeting_service.MeetingSession("ABCDEFGH", "secret", record, Language.english)

    token = meeting_service.create_join_token(session, "user-1", "Anu", False, is_host=False)
    claims = api.TokenVerifier("test-key", "test-secret-long-enough-for-jwt").verify(token)

    assert claims.video.room_join is True
    assert claims.video.room == "helascribe-abcdefgh"
    assert claims.video.can_publish_sources == ["microphone"]
    assert claims.video.can_publish_data is False


def test_only_host_secret_can_end_meeting(monkeypatch) -> None:
    from app.api.routes import meetings
    from app.models.schemas import MeetingEnd

    class FakeSession:
        host_secret = "correct"
        record = SimpleNamespace(id="meeting-id")

        def __init__(self) -> None:
            self.ended = False

        async def end(self) -> None:
            self.ended = True

    session = FakeSession()
    monkeypatch.setattr(meetings.meeting_registry, "get", lambda _code: session)

    with pytest.raises(HTTPException) as denied:
        asyncio.run(meetings.end_meeting("ABCDEFGH", MeetingEnd(host_secret="wrong")))
    assert denied.value.status_code == 403

    result = asyncio.run(
        meetings.end_meeting("ABCDEFGH", MeetingEnd(host_secret="correct"))
    )
    assert result == {"id": "meeting-id", "status": "processing"}
    assert session.ended is True
