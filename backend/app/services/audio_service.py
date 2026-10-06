import io
import math
import struct
import wave

import webrtcvad


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

    def feed(self, pcm: bytes) -> bool:
        """Return true when this input contains a voice-like 20 ms frame."""
        self.pending.extend(pcm[: len(pcm) - len(pcm) % 2])
        detected = False
        offset = 0
        while offset + self.frame_bytes <= len(self.pending):
            frame = bytes(self.pending[offset : offset + self.frame_bytes])
            offset += self.frame_bytes
            if pcm_rms(frame) >= self.energy_floor and self.vad.is_speech(
                frame, self.sample_rate
            ):
                detected = True
        if offset:
            del self.pending[:offset]
        return detected


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
