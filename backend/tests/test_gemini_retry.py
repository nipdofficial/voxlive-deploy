import asyncio
from types import SimpleNamespace

from google.genai import errors

from app.models.schemas import GeminiTranscript, Language, TranscriptSegment
from app.services.gemini_service import GeminiService


def test_transcription_retries_resource_exhausted() -> None:
    attempts = 0

    class FakeModels:
        async def generate_content(self, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise errors.ClientError(
                    429,
                    {
                        "error": {
                            "code": 429,
                            "status": "RESOURCE_EXHAUSTED",
                            "message": "try again",
                        }
                    },
                )
            return SimpleNamespace(parsed=GeminiTranscript(segments=[]), text=None)

    service = GeminiService.__new__(GeminiService)
    service.settings = SimpleNamespace(
        gemini_batch_model="batch-model",
        gemini_batch_timeout_seconds=10,
        gemini_max_retries=1,
        gemini_retry_base_seconds=0,
    )
    service.client = SimpleNamespace(
        aio=SimpleNamespace(models=FakeModels()),
    )

    result = asyncio.run(
        service.transcribe_file(b"audio", "audio/wav", Language.english)
    )

    assert result == []
    assert attempts == 2


def test_transcription_times_out_instead_of_hanging() -> None:
    class SlowModels:
        async def generate_content(self, **_kwargs):
            await asyncio.sleep(1)

    service = GeminiService.__new__(GeminiService)
    service.settings = SimpleNamespace(
        gemini_batch_model="batch-model",
        gemini_batch_timeout_seconds=0.001,
        gemini_max_retries=0,
        gemini_retry_base_seconds=0,
    )
    service.client = SimpleNamespace(
        aio=SimpleNamespace(models=SlowModels()),
    )

    try:
        asyncio.run(service.transcribe_file(b"audio", "audio/wav", Language.english))
    except RuntimeError as exc:
        assert "timed out" in str(exc)
    else:
        raise AssertionError("A stalled Gemini request must time out")


def test_transcription_retries_timeout_before_success() -> None:
    attempts = 0

    class SlowOnceModels:
        async def generate_content(self, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                await asyncio.sleep(1)
            return SimpleNamespace(parsed=GeminiTranscript(segments=[]), text=None)

    service = GeminiService.__new__(GeminiService)
    service.settings = SimpleNamespace(
        gemini_batch_model="batch-model",
        gemini_batch_timeout_seconds=0.001,
        gemini_max_retries=1,
        gemini_retry_base_seconds=0,
    )
    service.client = SimpleNamespace(aio=SimpleNamespace(models=SlowOnceModels()))

    result = asyncio.run(
        service.transcribe_file(b"audio", "audio/wav", Language.english)
    )

    assert result == []
    assert attempts == 2


def test_optional_mixed_language_verification_timeout_keeps_transcript() -> None:
    attempts = 0

    class VerificationTimeoutModels:
        async def generate_content(self, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return SimpleNamespace(
                    parsed=GeminiTranscript(
                        segments=[
                            TranscriptSegment(
                                start=0,
                                end=1,
                                text="Hello world",
                                detected_language="English",
                            )
                        ]
                    ),
                    text=None,
                )
            await asyncio.sleep(1)

    service = GeminiService.__new__(GeminiService)
    service.settings = SimpleNamespace(
        gemini_batch_model="batch-model",
        gemini_text_model="text-model",
        gemini_batch_timeout_seconds=0.001,
        gemini_max_retries=0,
        gemini_retry_base_seconds=0,
    )
    service.client = SimpleNamespace(
        aio=SimpleNamespace(models=VerificationTimeoutModels())
    )

    result = asyncio.run(
        service.transcribe_file(b"audio", "audio/wav", Language.mixed)
    )

    assert [segment.text for segment in result] == ["Hello world"]
    assert attempts == 2
