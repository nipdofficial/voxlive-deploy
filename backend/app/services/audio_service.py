import io
import math
import re
import subprocess
import struct
import wave
from pathlib import Path

import webrtcvad


_DURATION_PATTERN = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def probe_audio_duration(path: Path) -> float | None:
    """Return the container's real duration without loading the file into memory."""
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as wav:
                return wav.getnframes() / wav.getframerate()
        except (wave.Error, EOFError, ZeroDivisionError):
            return None
    try:
        import imageio_ffmpeg

        process = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-i", str(path)],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        match = _DURATION_PATTERN.search(process.stderr)
        if not match:
            return None
        hours, minutes, seconds = match.groups()
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except (OSError, subprocess.SubprocessError, ImportError):
        return None


class SpeechActivityDetector:
    """Stateful WebRTC VAD for mono PCM16 audio in supported sample rates."""

    def __init__(self, sample_rate: int = 16_000, energy_floor: float = 180.0) -> None:
        if sample_rate not in (8_000, 16_000, 32_000, 48_000):
            raise ValueError("WebRTC VAD requires an 8, 16, 32, or 48 kHz sample rate")
        self.sample_rate = sample_rate
        self.energy_floor = energy_floor
        self.frame_bytes = sample_rate // 50 * 2  # 20 ms, mono PCM16
        self.pending = bytearray()
        self.vad = webrtcvad.Vad(3)
        # One isolated click or burst must not unlock a generative model.
        # Require sustained speech across 100 ms. A short pre-roll in the
        # caller preserves initial consonants once this gate opens.
        self.consecutive_voice_frames = 0
        self.noise_rms = 0.0
        self.hangover_frames = 0

    def feed(self, pcm: bytes) -> bool:
        """Return true when this input contains a voice-like 20 ms frame."""
        self.pending.extend(pcm[: len(pcm) - len(pcm) % 2])
        active = False
        offset = 0
        while offset + self.frame_bytes <= len(self.pending):
            frame = bytes(self.pending[offset : offset + self.frame_bytes])
            offset += self.frame_bytes
            energy = pcm_rms(frame)
            vad_speech = self.vad.is_speech(frame, self.sample_rate)
            if not vad_speech:
                # Learn the room floor only from frames WebRTC considers
                # non-speech. This follows changing fan/air-conditioner noise
                # without allowing a loud voice to raise its own threshold.
                self.noise_rms = energy if not self.noise_rms else (
                    self.noise_rms * 0.92 + energy * 0.08
                )
            adaptive_floor = max(self.energy_floor, self.noise_rms * 2.4)
            voiced = energy >= adaptive_floor and vad_speech
            self.consecutive_voice_frames = (
                self.consecutive_voice_frames + 1 if voiced else 0
            )
            if self.consecutive_voice_frames >= 5:
                self.hangover_frames = 12  # 240 ms at 20 ms per frame
            elif self.hangover_frames:
                self.hangover_frames -= 1
            active = active or self.hangover_frames > 0
        if offset:
            del self.pending[:offset]
        return active


def contains_speech(
    pcm: bytes, sample_rate: int = 16_000, energy_floor: float = 180.0
) -> bool:
    """Classify a complete PCM recording, including chunks shorter than a frame."""
    return SpeechActivityDetector(sample_rate, energy_floor).feed(pcm)


def pcm_rms(pcm: bytes) -> float:
    """Return DC-adjusted RMS for little-endian signed PCM16 audio."""
    sample_bytes = len(pcm) - (len(pcm) % 2)
    if not sample_bytes:
        return 0.0
    samples = [sample[0] for sample in struct.iter_unpack("<h", pcm[:sample_bytes])]
    mean = sum(samples) / len(samples)
    return math.sqrt(sum((sample - mean) ** 2 for sample in samples) / len(samples))


def gate_pcm_noise(pcm: bytes, threshold: float) -> bytes:
    """Silence low-level microphone noise without changing the audio timeline."""
    if not pcm or pcm_rms(pcm) < threshold:
        return bytes(len(pcm))
    return pcm


def wav_rms(audio: bytes) -> float | None:
    """Read mono/stereo 16-bit WAV energy, or return None for another encoding."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            if wav.getsampwidth() != 2:
                return None
            return pcm_rms(wav.readframes(wav.getnframes()))
    except (wave.Error, EOFError):
        return None


def wav_contains_speech(audio: bytes, energy_floor: float = 180.0) -> bool | None:
    """Run VAD on PCM16 WAVs, returning None when the WAV format is unsupported."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            if sample_width != 2 or sample_rate not in (8_000, 16_000, 32_000, 48_000):
                return None
            if channels < 1:
                return None
            detector = SpeechActivityDetector(sample_rate, energy_floor)
            detected = False
            while frames := wav.readframes(4_800):
                if channels == 1:
                    mono = frames
                else:
                    packed = frames[: len(frames) - len(frames) % (2 * channels)]
                    interleaved = [sample[0] for sample in struct.iter_unpack("<h", packed)]
                    mono_samples = [
                        sum(interleaved[index : index + channels]) // channels
                        for index in range(0, len(interleaved), channels)
                    ]
                    mono = struct.pack(f"<{len(mono_samples)}h", *mono_samples)
                detected = detector.feed(mono) or detected
            return detected
    except (wave.Error, EOFError, struct.error):
        return None
