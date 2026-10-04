import asyncio
import subprocess
import wave
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.models.schemas import TranscriptSegment


@lru_cache(maxsize=1)
def _load_pipeline() -> Any:
    settings = get_settings()
    if not settings.huggingface_token:
        raise RuntimeError(
            "HUGGINGFACE_TOKEN is required. Accept the Community-1 model terms first."
        )
    # Lazy loading keeps the API and non-diarization paths usable on hosts that
    # intentionally do not install the large optional inference stack.
    import torch
    from pyannote.audio import Pipeline
    from pyannote.audio.core.task import Problem, Resolution, Specifications

    # PyTorch 2.6+ defaults checkpoint loading to weights_only=True. The
    # official Community-1 checkpoint contains this pyannote metadata class,
    # so allowlist that specific type rather than disabling safe loading.
    torch.serialization.add_safe_globals([Specifications, Problem, Resolution])

    return Pipeline.from_pretrained(
        settings.pyannote_model, token=settings.huggingface_token
    )


def _decode_audio(path: str) -> dict[str, Any]:
    """Decode to mono 16 kHz in memory, bypassing TorchCodec on Windows."""
    import numpy as np
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
    except ModuleNotFoundError:
        with wave.open(str(Path(path).resolve()), "rb") as source:
            if source.getframerate() != 16_000 or source.getsampwidth() != 2:
                raise RuntimeError("Audio decoder is unavailable for this format")
            raw = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
            channels = max(1, source.getnchannels())
            samples = raw.reshape(-1, channels).mean(axis=1).astype("<f4") / 32768.0
    else:
        completed = subprocess.run(
            [
                get_ffmpeg_exe(), "-v", "error", "-i", str(Path(path).resolve()),
                "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1",
            ],
            check=True,
            capture_output=True,
        )
        samples = np.frombuffer(completed.stdout, dtype="<f4").copy()
    if samples.size == 0:
        raise ValueError("Audio decoder produced no samples")
    try:
        import torch
    except ModuleNotFoundError:
        # PyTorch is an optional diarization dependency. The decoder remains
        # usable for validation and lightweight deployments; the pyannote
        # pipeline itself still fails clearly if inference is requested.
        waveform: Any = samples[None, :]
    else:
        waveform = torch.from_numpy(samples).unsqueeze(0)
    return {"waveform": waveform, "sample_rate": 16_000}


def _run_pipeline(path: str) -> list[TranscriptSegment]:
    output = _load_pipeline()(_decode_audio(path))
    # Community-1's exclusive timeline guarantees a single active speaker and
    # is specifically intended for reconciling diarization with ASR timestamps.
    annotation = getattr(
        output,
        "exclusive_speaker_diarization",
        getattr(output, "speaker_diarization", output),
    )
    segments: list[TranscriptSegment] = []
    if hasattr(annotation, "itertracks"):
        iterator = ((turn, speaker) for turn, _, speaker in annotation.itertracks(yield_label=True))
    else:
        iterator = iter(annotation)
    for turn, speaker in iterator:
        segments.append(
            TranscriptSegment(
                start=float(turn.start),
                end=float(turn.end),
                text="",
                speaker=str(speaker),
            )
        )
    return segments


async def diarize_file(path: str) -> list[TranscriptSegment]:
    """Run gated pyannote inference without blocking FastAPI's event loop."""
    return await asyncio.to_thread(_run_pipeline, path)


async def warm_up_diarization() -> bool:
    """Preload the pyannote pipeline so the first job avoids model-load latency."""
    settings = get_settings()
    if not settings.huggingface_token:
        return False
    await asyncio.to_thread(_load_pipeline)
    return True


def merge_transcript_and_speakers(
    transcript: list[TranscriptSegment], speakers: list[TranscriptSegment]
) -> list[TranscriptSegment]:
    merged: list[TranscriptSegment] = []
    for utterance in transcript:
        best_speaker: str | None = None
        best_overlap = 0.0
        midpoint = (utterance.start + utterance.end) / 2
        for turn in speakers:
            overlap = max(
                0.0,
                min(utterance.end, turn.end) - max(utterance.start, turn.start),
            )
            contains_midpoint = turn.start <= midpoint <= turn.end
            score = overlap + (0.001 if contains_midpoint else 0)
            if score > best_overlap:
                best_overlap = score
                best_speaker = turn.speaker
        merged.append(
            utterance.model_copy(
                update={"speaker": best_speaker or "SPEAKER_UNKNOWN"}
            )
        )
    return merged
