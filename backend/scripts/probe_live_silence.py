"""Manual Vertex Live probe: stream generated silence without logging credentials.

Run from backend with: python -m scripts.probe_live_silence
This makes a real, potentially billable provider request; it does not validate
speech recognition or translation quality.
"""

import asyncio
from google.genai import types
from app.services.gemini_service import GeminiService


async def main() -> None:
    service = GeminiService()
    config = types.LiveConnectConfig(
        response_modalities=["TEXT"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
    )
    async with service.client.aio.live.connect(
        model="gemini-3.5-transcribe-live", config=config
    ) as session:
        print("Live session connected")
        await session.send_realtime_input(
            audio=types.Blob(data=bytes(32000), mime_type="audio/pcm;rate=16000")
        )
        await session.send_realtime_input(audio_stream_end=True)

        async def receive():
            async for response in session.receive():
                content = response.server_content
                if content:
                    for field in ("interim_input_transcription", "input_transcription"):
                        item = getattr(content, field, None)
                        if item and (getattr(item, "text", "") or "").strip():
                            return True
            return False

        try:
            generated = await asyncio.wait_for(receive(), timeout=15)
            print(f"Silence produced nonempty transcription: {generated}")
        except TimeoutError:
            print("No transcription received before timeout")


if __name__ == "__main__":
    asyncio.run(main())
