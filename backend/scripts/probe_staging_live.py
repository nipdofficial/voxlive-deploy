"""Exercise standalone Live against an isolated localhost server and a WAV file.

Makes real provider calls and transmits the specified audio to the configured
provider. Only run with authorized test audio. Does not print speech or tokens.
"""
import asyncio
import json
import os
import re
import time
import uuid
import wave

import httpx
import websockets


async def main() -> None:
    silence_seconds = int(os.environ.get("VOXLIVE_PROBE_SILENCE_SECONDS", "0"))
    if silence_seconds:
        pcm = bytes(32000 * silence_seconds)
    else:
        path = os.environ["VOXLIVE_PROBE_AUDIO"]
        with wave.open(path, "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
                raise ValueError("Probe audio must be mono PCM16 at 16000 Hz")
            pcm = source.readframes(source.getnframes())

    base = os.environ.get("VOXLIVE_PROBE_API_BASE", "http://127.0.0.1:8000/api")
    if base not in {"http://127.0.0.1:8000/api", "http://127.0.0.1:8001/api"}:
        raise ValueError("Probe may only target the isolated local staging ports")
    email = f"probe-{uuid.uuid4().hex}@example.invalid"
    password = "temporary-local-probe-password"
    async with httpx.AsyncClient(timeout=20) as client:
        registration = await client.post(f"{base}/auth/register", json={"name": "Local Probe", "email": email, "password": password})
        registration.raise_for_status()
        login = await client.post(f"{base}/auth/login", json={"email": email, "password": password})
        login.raise_for_status()
        token = login.json()["token"]

    mode = os.environ.get("VOXLIVE_PROBE_MODE", "Live")
    if mode not in ("Live", "Record"):
        raise ValueError("Probe mode must be Live or Record")
    async with websockets.connect(base.replace("http://", "ws://", 1) + "/live", max_size=2**22) as socket:
        await socket.send(json.dumps({"token": token, "language": "Mixed", "session_type": mode, "realtime_translation": mode == "Live", "sample_rate": 16000, "title": "Local audio probe"}))
        ready = json.loads(await asyncio.wait_for(socket.recv(), 10))
        if ready.get("type") != "ready":
            raise RuntimeError(f"Live socket did not become ready: {ready.get('type')}")
        started = time.monotonic()
        events = []
        source_text = []

        async def receive():
            async for message in socket:
                event = json.loads(message)
                event_type = event.get("type")
                if event_type in ("transcript", "translation", "warning", "error"):
                    events.append((event_type, round(time.monotonic() - started, 2), (event.get("segment") or {}).get("detected_language")))
                    if event_type == "transcript":
                        source_text.append((event.get("segment") or {}).get("text", ""))

        receiver = asyncio.create_task(receive())
        for offset in range(0, len(pcm), 3200):
            await socket.send(pcm[offset:offset + 3200])
            await asyncio.sleep(0.1)
        # A real microphone continues producing silent PCM after the speaker
        # pauses. Stream that tail so hybrid VAD can finalize before Stop.
        for _ in range(10):
            await socket.send(bytes(3200))
            await asyncio.sleep(0.1)
        # Keep the stream open briefly to distinguish live results from finalization.
        await asyncio.sleep(15)
        live_events = list(events)
        await socket.send("stop")
        try:
            await asyncio.wait_for(receiver, timeout=15)
        except TimeoutError:
            receiver.cancel()
        print("Live event timings before stop:", live_events)
        print("Source appeared before stop:", any(item[0] == "transcript" for item in live_events))
        print("Translation appeared before stop:", any(item[0] == "translation" for item in live_events))
        expected = os.environ.get("VOXLIVE_PROBE_EXPECTED")
        if expected:
            normalize = lambda value: " ".join(
                re.sub(r"[^\w]+", " ", value.casefold()).split()
            )
            print(
                "Expected phrase present:",
                normalize(expected) in normalize(" ".join(source_text)),
            )
    if mode == "Record":
        async with httpx.AsyncClient(timeout=90) as client:
            headers = {"Authorization": f"Bearer {token}"}
            for _ in range(45):
                await asyncio.sleep(2)
                response = await client.get(f"{base}/history/{ready['id']}", headers=headers)
                response.raise_for_status()
                record = response.json()
                if record["status"] in ("completed", "failed"):
                    print("Record saved status:", record["status"], "original lines:", len(record["segments"]), "automatic translation:", any(item.get("translated_text") for item in record["segments"]))
                    if record["status"] == "completed" and record["segments"]:
                        original = [item["text"] for item in record["segments"]]
                        result = await client.post(f"{base}/history/{ready['id']}/translate", headers=headers, json={"target_language": "Tamil"})
                        result.raise_for_status()
                        saved = (await client.get(f"{base}/history/{ready['id']}", headers=headers)).json()
                        print("Requested translation persisted:", any(item.get("translated_text") for item in saved["segments"]), "original preserved:", original == [item["text"] for item in saved["segments"]])
                    break
            else:
                print("Record finalization did not complete within the test window")


if __name__ == "__main__":
    asyncio.run(main())
