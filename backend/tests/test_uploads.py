import asyncio
import io
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.api.routes.transcribe import _read_limited, _upload_mime_type, _wav_duration
from app.services.audio_service import wav_rms
from app.api.routes import transcribe
from app.models.schemas import JobStatus, Language, SessionType, TranscriptRecord, TranscriptSegment


def test_upload_reader_accepts_content_within_limit() -> None:
    upload = UploadFile(filename="voice.wav", file=io.BytesIO(b"abc"))
    assert asyncio.run(_read_limited(upload, 3)) == b"abc"


def test_upload_reader_rejects_empty_and_oversized_files() -> None:
    async def assert_error(chunks: list[bytes], limit: int, status: int) -> None:
        upload = UploadFile(filename="voice.wav", file=io.BytesIO(b"".join(chunks)))
        with pytest.raises(HTTPException) as raised:
            await _read_limited(upload, limit)
        assert raised.value.status_code == status

    asyncio.run(assert_error([b""], 3, 400))
    asyncio.run(assert_error([b"abcd", b""], 3, 413))


def test_wav_duration_uses_actual_frames() -> None:
    output = io.BytesIO()
    import wave

    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\x00\x00" * 16_000)

    assert _wav_duration(output.getvalue()) == 1.0
    assert wav_rms(output.getvalue()) == 0.0


def test_upload_mime_type_falls_back_for_generic_picker_types() -> None:
    assert _upload_mime_type("application/octet-stream", ".m4a") == "audio/mp4"
    assert _upload_mime_type(None, ".webm") == "audio/webm"
    assert _upload_mime_type("video/mp4", ".mp4") == "audio/mp4"
    assert _upload_mime_type("audio/x-custom", ".wav") == "audio/x-custom"


@pytest.mark.parametrize("mode", [SessionType.upload, SessionType.record])
def test_file_processing_preserves_original_without_automatic_translation(monkeypatch, tmp_path, mode) -> None:
    audio = tmp_path / "speech.mp3"
    audio.write_bytes(b"audio")
    record = TranscriptRecord(title="test", language=Language.mixed, session_type=mode, diarization=False)

    class FakeGemini:
        async def transcribe_file(self, *_args, **kwargs):
            assert kwargs.get("translate_to") is None
            return [TranscriptSegment(start=0, end=1, text="Hello")]

        async def translate_segments(self, *_args, **_kwargs):
            raise AssertionError("Translation must be requested separately")

    async def save(saved):
        return saved

    monkeypatch.setattr(transcribe, "GeminiService", FakeGemini)
    monkeypatch.setattr(transcribe, "save_record", save)
    monkeypatch.setattr(transcribe, "get_settings", lambda: SimpleNamespace(auto_translate=True, live_voice_rms_threshold=180, live_silence_rms_threshold=0))
    asyncio.run(transcribe._process(record, audio, "audio/mpeg"))
    assert record.status == JobStatus.completed
    assert record.segments[0].text == "Hello"
    assert not record.segments[0].translated_text
