import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

from app.api.routes.transcribe import _read_limited, _upload_mime_type, _wav_duration
from app.services.audio_service import wav_rms


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
