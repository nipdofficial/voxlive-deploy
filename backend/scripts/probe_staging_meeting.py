"""Exercise a local staging meeting through actual LiveKit and Gemini services.

Requires a running isolated local server and authorized mono PCM16/16kHz WAV
in VOXLIVE_PROBE_AUDIO. Audio is sent to the configured speech provider and
the test creates a temporary LiveKit room. Outputs timings, never credentials
or transcript contents. Provider usage may incur charges.
"""
import asyncio
import json
import os
import time
import uuid
import wave

import httpx
import websockets
from livekit import rtc


async def main() -> None:
    silence_seconds = int(os.environ.get("VOXLIVE_PROBE_SILENCE_SECONDS", "0"))
    if silence_seconds:
        pcm = bytes(32000 * silence_seconds)
    else:
        with wave.open(os.environ["VOXLIVE_PROBE_AUDIO"], "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
                raise ValueError("Audio must be mono PCM16 at 16000 Hz")
            pcm = source.readframes(source.getnframes())
    base = "http://127.0.0.1:8000/api"
    email = f"meeting-probe-{uuid.uuid4().hex}@example.invalid"
    password = "temporary-local-probe-password"
    room = None
    connection = None
    started = False
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(f"{base}/auth/register", json={"name": "Local organizer", "email": email, "password": password})
        response.raise_for_status()
        response = await client.post(f"{base}/auth/login", json={"email": email, "password": password})
        response.raise_for_status()
        organizer_token = response.json()["token"]
        headers = {"Authorization": f"Bearer {organizer_token}"}
        response = await client.post(f"{base}/meetings", headers=headers, json={"display_name": "Local organizer", "language": "Mixed", "title": "Local meeting probe", "start_mode": "Live"})
        response.raise_for_status()
        connection = response.json()
        code = connection["room_code"]
        try:
            response = await client.post(f"{base}/meetings/{code}/start", headers=headers, json={"host_secret": connection["host_secret"]})
            response.raise_for_status()
            started = True
            response = await client.post(f"{base}/meetings/{code}/join", json={"display_name": "Local attendee", "invitation": connection["invitation_secret"], "shared_mic": False})
            response.raise_for_status()
            attendee = response.json()
            room = rtc.Room()
            events = []
            started_at = time.monotonic()

            @room.on("data_received")
            def on_data(packet):
                try:
                    item = json.loads(packet.data)
                    if item.get("type") in ("transcript", "translation", "warning"):
                        events.append((item["type"], round(time.monotonic() - started_at, 2), (item.get("segment") or {}).get("detected_language")))
                except (ValueError, UnicodeDecodeError):
                    pass

            await room.connect(attendee["livekit_url"], attendee["token"])
            async with websockets.connect(f"ws://127.0.0.1:8000/api/meetings/{code}/audio") as socket:
                await socket.send(json.dumps({"token": organizer_token, "host_secret": connection["host_secret"], "participant_identity": connection["participant_identity"]}))
                ready = json.loads(await asyncio.wait_for(socket.recv(), 10))
                if ready.get("type") != "ready":
                    raise RuntimeError("Organizer audio socket did not become ready")
                started_at = time.monotonic()
                for offset in range(0, len(pcm), 3200):
                    await socket.send(pcm[offset:offset + 3200])
                    await asyncio.sleep(0.1)
                await asyncio.sleep(5 if silence_seconds else 35)
            print("Attendee events before session end:", events)
            print("Attendee received live Tamil translation:", any(item[0] == "translation" for item in events))
        finally:
            if room:
                await room.disconnect()
            if started and connection:
                response = await client.post(f"{base}/meetings/{connection['room_code']}/end", headers=headers, json={"host_secret": connection["host_secret"]})
                print("Test meeting end HTTP:", response.status_code)


if __name__ == "__main__":
    asyncio.run(main())
