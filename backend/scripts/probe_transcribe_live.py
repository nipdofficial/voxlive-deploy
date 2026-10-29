"""Stream authorized 16-kHz WAV audio to Gemini's transcription Live API.

Requires VOXLIVE_PROBE_AUDIO. This makes billable provider calls and does not
print speech, credentials, tokens or model response contents.
"""
import asyncio
import os
import time
import wave

from google.genai import types
from app.services.gemini_service import GeminiService


async def main() -> None:
    with wave.open(os.environ["VOXLIVE_PROBE_AUDIO"], "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
            raise ValueError("Audio must be mono PCM16 at 16000 Hz")
        pcm = source.readframes(source.getnframes())
    service = GeminiService()
    config = types.LiveConnectConfig(response_modalities=["TEXT"], input_audio_transcription=types.AudioTranscriptionConfig())
    async with service.client.aio.live.connect(model="gemini-3.5-transcribe-live", config=config) as session:
        started = time.monotonic()
        events = []
        final_text = []
        async def receive():
            async for response in session.receive():
                content = response.server_content
                if not content:
                    continue
                for field in ("interim_input_transcription", "input_transcription"):
                    item = getattr(content, field, None)
                    if item and (getattr(item, "text", "") or "").strip():
                        events.append((field, round(time.monotonic() - started, 2), getattr(item, "language_code", None)))
                        if field == "input_transcription":
                            final_text.append(item.text)
        receiver = asyncio.create_task(receive())
        for offset in range(0, len(pcm), 3200):
            await session.send_realtime_input(audio=types.Blob(data=pcm[offset:offset + 3200], mime_type="audio/pcm;rate=16000"))
            await asyncio.sleep(0.1)
        await session.send_realtime_input(audio_stream_end=True)
        try:
            await asyncio.wait_for(receiver, 15)
        except TimeoutError:
            receiver.cancel()
        print("Recognition event timings:", events)
        print("Final transcription received:", any(item[0] == "input_transcription" for item in events))
        expected = os.environ.get("VOXLIVE_PROBE_EXPECTED")
        if expected:
            print("Expected phrase present:", expected.casefold() in " ".join(final_text).casefold())


if __name__ == "__main__":
    asyncio.run(main())
