import asyncio
import io
import math
import struct
import wave
from pathlib import Path
from types import SimpleNamespace

from app.api.routes import live
from app.models.schemas import (
    JobStatus,
    Language,
    SpokenLanguage,
    SessionType,
    TranscriptRecord,
    TranscriptSegment,
)


def test_pcm_wav_bytes_preserves_stream_format() -> None:
    pcm = b"\x00\x00\xff\x7f\x00\x80"

    encoded = live._pcm_wav_bytes(pcm, sample_rate=16_000)

    with wave.open(io.BytesIO(encoded), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 16_000
        assert wav.readframes(wav.getnframes()) == pcm


def test_raw_to_wav_streams_pcm_into_a_valid_wave_file(tmp_path: Path) -> None:
    pcm = struct.pack("<6h", -1_000, 1_000, -500, 500, 0, 250)
    raw_path = tmp_path / "recording.pcm.part"
    wav_path = tmp_path / "recording.wav"
    raw_path.write_bytes(pcm)

    live._raw_to_wav(raw_path, wav_path, sample_rate=16_000)

    with wave.open(str(wav_path), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 16_000
        assert wav.getnframes() == len(pcm) // 2
        assert wav.readframes(wav.getnframes()) == pcm


def test_pcm_rms_rejects_silence_and_detects_audio() -> None:
    assert live._pcm_rms(b"\x00\x00" * 1_000) == 0

    alternating_signal = struct.pack("<1000h", *([-1_000, 1_000] * 500))
    assert live._pcm_rms(alternating_signal) == 1_000


def test_overlap_commits_each_segment_once_by_midpoint() -> None:
    old_overlap = TranscriptSegment(start=7.1, end=7.8, text="already emitted")
    boundary_word = TranscriptSegment(start=7.8, end=8.4, text="keep intact")

    assert live._is_committed_segment(old_overlap, 8.0) is False
    assert live._is_committed_segment(boundary_word, 8.0) is True


def test_preview_deduplication_ignores_repeated_overlap_result() -> None:
    record = TranscriptRecord(
        title="Live test",
        language=Language.mixed,
        session_type=SessionType.live,
        segments=[TranscriptSegment(start=1.0, end=1.8, text="same phrase")],
    )

    assert live._append_preview_segment(
        record,
        TranscriptSegment(start=1.05, end=1.85, text="same phrase"),
    ) is False
    assert live._append_preview_segment(
        record,
        TranscriptSegment(start=2.0, end=2.8, text="different phrase"),
    ) is True


def test_preview_queue_can_be_skipped_when_full_audio_will_replace_it(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=True, max_upload_mb=20),
    )

    assert live._can_finalize_from_full_audio(1_000_000) is True


def test_preview_queue_is_drained_when_final_pass_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=False, max_upload_mb=20),
    )
    assert live._can_finalize_from_full_audio(1_000_000) is False

    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=True, max_upload_mb=1),
    )
    assert live._can_finalize_from_full_audio(2_000_000) is False


def test_slow_preview_keeps_latest_chunk_without_blocking_audio_capture() -> None:
    queue: asyncio.Queue[tuple[bytes, float, float] | None] = asyncio.Queue(
        maxsize=2
    )
    first = (b"first", 0.0, 0.0)
    second = (b"second", 2.5, 3.0)
    latest = (b"latest", 5.0, 5.5)
    queue.put_nowait(first)
    queue.put_nowait(second)

    dropped = live._enqueue_latest_preview(queue, latest)

    assert dropped is True
    assert queue.get_nowait() == second
    assert queue.get_nowait() == latest


def test_live_chunk_requests_provisional_gemini_speakers(monkeypatch) -> None:
    calls: list[dict] = []

    class FakeGemini:
        async def transcribe_file(self, *_args, **kwargs):
            calls.append(kwargs)
            return []

    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(
            gemini_text_model="flash-model",
            gemini_live_timeout_seconds=12.0,
        ),
    )
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=True,
    )

    asyncio.run(
        live._transcribe_live_chunk(
            FakeGemini(),
            b"\x00\x00" * 16_000,
            16_000,
            record,
            7.0,
        )
    )

    assert calls == [
        {
            "model": "flash-model",
            "timestamp_offset": 7.0,
            "include_speakers": True,
            "audio_duration_seconds": 1.0,
            "request_timeout_seconds": 12.0,
            "verify_mixed_language": False,
            "use_structured_mixed_model": True,
        }
    ]


def test_live_language_hints_cover_only_supported_languages() -> None:
    assert live._live_language_codes(Language.sinhala) == ["si-LK"]
    assert live._live_language_codes(Language.mixed) == ["si-LK", "ta-IN", "en-US"]


def test_live_noise_gate_silences_quiet_noise_and_preserves_speech() -> None:
    quiet_noise = struct.pack("<1000h", *([40, -40] * 500))
    speech = struct.pack("<1000h", *([800, -800] * 500))

    assert live._gate_live_pcm(quiet_noise, 120.0) == bytes(len(quiet_noise))
    assert live._gate_live_pcm(speech, 120.0) == speech


def test_live_provider_output_requires_recent_voice_activity() -> None:
    assert not live._has_recent_voice_activity(None, 10.0, 4.0)
    assert live._has_recent_voice_activity(8.0, 10.0, 4.0)
    assert not live._has_recent_voice_activity(5.0, 10.0, 4.0)


def test_voice_activity_detector_rejects_silence_and_quiet_room_hum() -> None:
    from app.services.audio_service import contains_speech

    sample_rate = 16_000
    samples = sample_rate * 2
    silence = bytes(samples * 2)
    quiet_hum = struct.pack(
        f"<{samples}h",
        *[
            int(40 * math.sin(2 * math.pi * 60 * index / sample_rate))
            for index in range(samples)
        ],
    )

    assert not contains_speech(silence)
    assert not contains_speech(quiet_hum)


def test_voice_activity_detector_handles_split_pcm_frames_and_voiced_audio() -> None:
    from app.services.audio_service import SpeechActivityDetector, contains_speech

    sample_rate = 16_000
    samples = sample_rate
    voiced = struct.pack(
        f"<{samples}h",
        *[
            int(
                900
                * sum(
                    math.sin(2 * math.pi * frequency * index / sample_rate) / harmonic
                    for harmonic, frequency in enumerate((160, 320, 480, 640), 1)
                )
            )
            for index in range(samples)
        ],
    )
    detector = SpeechActivityDetector()

    assert contains_speech(voiced)
    assert not detector.feed(voiced[:400])
    assert detector.feed(voiced[400:])


def test_silent_final_audio_clears_false_live_preview(monkeypatch, tmp_path: Path) -> None:
    path = tmp_path / "silent.wav"
    path.write_bytes(live._pcm_wav_bytes(bytes(16_000 * 2), 16_000))
    record = TranscriptRecord(
        title="Silent live test",
        language=Language.sinhala,
        session_type=SessionType.live,
        status=JobStatus.processing,
        segments=[TranscriptSegment(start=0, end=1, text="fabricated preview")],
    )

    async def unexpected_transcription(*_args, **_kwargs):
        raise AssertionError("Gemini must not be called for silent audio")

    async def ignore_save(_record):
        return _record

    monkeypatch.setattr(live, "GeminiService", lambda: SimpleNamespace(transcribe_file=unexpected_transcription))
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(
            live_finalize_full_audio=True,
            max_upload_mb=20,
            live_voice_rms_threshold=180.0,
            live_silence_rms_threshold=20.0,
        ),
    )

    asyncio.run(live._finalize_live(record, path))

    assert record.status == JobStatus.completed
    assert record.segments == []
    assert record.transcript == ""


def test_unicode_script_overrides_conflicting_live_language_code() -> None:
    assert live._live_detected_language("si-LK", "வணக்கம்") == SpokenLanguage.tamil
    assert live._live_detected_language("ta-IN", "ආයුබෝවන්") == SpokenLanguage.sinhala


def test_mixed_mode_only_accepts_sinhala_tamil_and_english_scripts() -> None:
    assert live._live_text_matches_mode("ආයුබෝවන්", Language.mixed)
    assert live._live_text_matches_mode("வணக்கம்", Language.mixed)
    assert live._live_text_matches_mode("hello there", Language.mixed)
    assert not live._live_text_matches_mode("नमस्ते", Language.mixed)


def test_live_mono_language_rejects_transcription_in_wrong_script() -> None:
    tamil_text = live.types.Transcription(text="வணக்கம்")
    sinhala_text = live.types.Transcription(text="ආයුබෝවන්")

    assert live._live_segment(tamil_text, 0.0, Language.sinhala) is None
    accepted = live._live_segment(sinhala_text, 0.0, Language.sinhala)
    assert accepted is not None
    assert accepted.detected_language == SpokenLanguage.sinhala


def test_default_live_model_is_supported_by_gemini_live_api() -> None:
    from app.core.config import Settings

    assert Settings().gemini_live_model == "gemini-3.8-live"
    assert Settings(gemini_live_model="gemini-3.5-transcribe-preview").gemini_live_model == "gemini-3.8-live"
    assert Settings(gemini_live_model="gemini-live-2.5-flash-native-audio").gemini_live_model == "gemini-3.8-live"
    assert Settings(gemini_batch_model="gemini-2.5-flash").gemini_batch_model == "gemini-3.8-flash"
    assert Settings(gemini_text_model="gemini-2.5-flash").gemini_text_model == "gemini-3.8-flash"


def test_live_chunk_disables_gemini_speakers_when_toggle_is_off(monkeypatch) -> None:
    calls: list[dict] = []

    class FakeGemini:
        async def transcribe_file(self, *_args, **kwargs):
            calls.append(kwargs)
            return []

    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(
            gemini_text_model="flash-model",
            gemini_live_timeout_seconds=12.0,
        ),
    )
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=False,
    )

    asyncio.run(
        live._transcribe_live_chunk(
            FakeGemini(),
            b"\x00\x00" * 16_000,
            16_000,
            record,
            0.0,
        )
    )

    assert calls[0]["include_speakers"] is False


def test_finalize_replaces_gemini_speakers_with_pyannote_when_enabled(
    monkeypatch,
) -> None:
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=True,
        status=JobStatus.processing,
        segments=[
            TranscriptSegment(start=0, end=1, text="hello", speaker="SPEAKER_00"),
            TranscriptSegment(start=1, end=2, text="there", speaker="SPEAKER_00"),
        ],
    )

    async def fake_diarization(_path: str):
        return [
            TranscriptSegment(start=0, end=1, text="", speaker="SPEAKER_00"),
            TranscriptSegment(start=1, end=2, text="", speaker="SPEAKER_01"),
        ]

    async def ignore_save(saved: TranscriptRecord):
        return saved

    monkeypatch.setattr(live, "diarize_file", fake_diarization)
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=False),
    )

    asyncio.run(live._finalize_live(record, Path("unused.wav")))

    assert [item.speaker for item in record.segments] == ["SPEAKER_00", "SPEAKER_01"]
    assert record.transcript == "SPEAKER_00: hello\nSPEAKER_01: there"


def test_finalize_skips_pyannote_when_toggle_is_off(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=False,
        status=JobStatus.processing,
        segments=[TranscriptSegment(start=0, end=1, text="hello")],
    )

    async def unexpected_diarization(_path: str):
        raise AssertionError("Pyannote must not run when diarization is disabled")

    async def ignore_save(saved: TranscriptRecord):
        return saved

    monkeypatch.setattr(live, "diarize_file", unexpected_diarization)
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=False),
    )

    asyncio.run(live._finalize_live(record, Path("unused.wav")))

    assert record.status == JobStatus.completed
    assert record.transcript == "hello"


def test_finalize_preserves_transcript_when_diarization_fails(monkeypatch) -> None:
    record = TranscriptRecord(
        title="Live test",
        language=Language.english,
        session_type=SessionType.live,
        diarization=True,
        status=JobStatus.processing,
        segments=[TranscriptSegment(start=0, end=1, text="hello")],
    )

    async def fail_diarization(_path: str):
        raise RuntimeError("model could not load")

    async def ignore_save(saved: TranscriptRecord):
        return saved

    monkeypatch.setattr(live, "diarize_file", fail_diarization)
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(live_finalize_full_audio=False),
    )

    asyncio.run(live._finalize_live(record, Path("unused.wav")))

    assert record.status == JobStatus.completed
    assert record.transcript == "hello"
    assert record.diarization is False
    assert record.error == "Speaker diarization unavailable: model could not load"


def test_finalize_replaces_chunk_previews_with_full_quality_pass(
    monkeypatch, tmp_path: Path
) -> None:
    path = tmp_path / "live.wav"
    path.write_bytes(b"complete recording")
    record = TranscriptRecord(
        title="Live test",
        language=Language.mixed,
        session_type=SessionType.live,
        status=JobStatus.processing,
        segments=[TranscriptSegment(start=0, end=1, text="preview")],
    )

    class FakeGemini:
        async def transcribe_file(self, *_args, **_kwargs):
            return [
                TranscriptSegment(
                    start=0,
                    end=2,
                    text="final transcript",
                )
            ]

    async def ignore_save(saved: TranscriptRecord):
        return saved

    monkeypatch.setattr(live, "GeminiService", FakeGemini)
    monkeypatch.setattr(live, "save_record", ignore_save)
    monkeypatch.setattr(
        live,
        "get_settings",
        lambda: SimpleNamespace(
            live_finalize_full_audio=True,
            max_upload_mb=20,
            gemini_batch_model="batch-model",
        ),
    )

    asyncio.run(live._finalize_live(record, path))

    assert [item.text for item in record.segments] == ["final transcript"]
    assert record.transcript == "final transcript"
    assert record.status == JobStatus.completed
