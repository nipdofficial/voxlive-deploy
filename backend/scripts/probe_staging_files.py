"""Test Record/Upload file processing against an isolated local backend.

Only use authorized test audio. Provider calls may incur charges. Transcript
contents and credentials are deliberately not printed.
"""
import asyncio
import os
import time
import uuid
from pathlib import Path

import httpx


async def main() -> None:
    audio = Path(os.environ["VOXLIVE_PROBE_AUDIO"]).read_bytes()
    base = os.environ.get("VOXLIVE_PROBE_API_BASE", "http://127.0.0.1:8000/api")
    if base not in {"http://127.0.0.1:8000/api", "http://127.0.0.1:8001/api"}:
        raise ValueError("Probe may only target the isolated local staging ports")
    email = f"file-probe-{uuid.uuid4().hex}@example.invalid"
    password = "temporary-local-probe-password"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(f"{base}/auth/register", json={"name": "Local probe", "email": email, "password": password})
        response.raise_for_status()
        response = await client.post(f"{base}/auth/login", json={"email": email, "password": password})
        response.raise_for_status()
        headers = {"Authorization": f"Bearer {response.json()['token']}"}
        for mode in ("Record", "Upload"):
            start = time.monotonic()
            response = await client.post(f"{base}/transcribe", headers=headers, data={"language": "Mixed", "session_type": mode, "diarization": "false", "title": f"Local {mode} test"}, files={"file": ("probe.wav", audio, "audio/wav")})
            response.raise_for_status()
            record_id = response.json()["id"]
            for _ in range(60):
                await asyncio.sleep(2)
                response = await client.get(f"{base}/history/{record_id}", headers=headers)
                response.raise_for_status()
                record = response.json()
                if record["status"] in ("completed", "failed"):
                    print(mode, "status:", record["status"], "duration_seconds:", round(time.monotonic()-start, 1), "source_nonempty:", bool(record.get("transcript")), "translation_present:", any(segment.get("translated_text") for segment in record.get("segments", [])))
                    if mode == "Record" and record["status"] == "completed" and record.get("segments"):
                        original = [segment["text"] for segment in record["segments"]]
                        translated = await client.post(f"{base}/history/{record_id}/translate", headers=headers, json={"target_language": "Tamil"}, timeout=90)
                        translated.raise_for_status()
                        saved = (await client.get(f"{base}/history/{record_id}", headers=headers)).json()
                        print("Record translation persisted:", any(item.get("translated_text") for item in saved["segments"]), "source preserved:", original == [item["text"] for item in saved["segments"]])
                    break
            else:
                print(mode, "status: timed out waiting for completion")


if __name__ == "__main__":
    asyncio.run(main())
