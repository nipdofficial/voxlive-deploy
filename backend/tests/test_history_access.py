import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.auth import Role, SessionRecord
from app.models.schemas import Language, SessionType, TranscriptRecord
from app.services.history_access import can_access_history, require_history_access
from app.api.routes import history
from app.core.config import get_settings
from app.main import app
from app.services.auth_service import auth_store
from fastapi.testclient import TestClient


def session(user_id: str, role: Role = Role.user) -> SessionRecord:
    now = datetime.now(timezone.utc)
    return SessionRecord(id="session", token_digest="digest", user_id=user_id,
                         name="Test", email="test@example.invalid", role=role,
                         created_at=now, last_seen_at=now, expires_at=now + timedelta(hours=1))


def record(owner: str | None) -> TranscriptRecord:
    return TranscriptRecord(title="test", language=Language.mixed, session_type=SessionType.live,
                            organizer_user_id=owner)


def test_organizers_see_only_their_own_history() -> None:
    assert can_access_history(record("alice"), session("alice"))
    assert not can_access_history(record("alice"), session("bob"))
    assert not can_access_history(record(None), session("alice"))


def test_legacy_history_is_available_to_admin_for_review() -> None:
    assert can_access_history(record(None), session("admin", Role.admin))


def test_unauthorized_and_missing_records_are_indistinguishable() -> None:
    for item in (record("alice"), None):
        with pytest.raises(HTTPException) as error:
            require_history_access(item, session("bob"))
        assert error.value.status_code == 404


def test_history_events_are_filtered_before_delivery(monkeypatch) -> None:
    async def run():
        alice_queue = asyncio.Queue()
        bob_queue = asyncio.Queue()
        monkeypatch.setattr(history, "_subscribers", {alice_queue: session("alice"), bob_queue: session("bob")})
        owned = record("alice")
        await history._publish({"type": "record", "record": owned.model_dump(mode="json")})
        assert (await alice_queue.get())["record"]["id"] == owned.id
        assert bob_queue.empty()
        await history._publish({"type": "deleted", "id": owned.id, "_access_record": owned})
        assert (await alice_queue.get()) == {"type": "deleted", "id": owned.id}
        assert bob_queue.empty()
    asyncio.run(run())


def test_attendee_transcript_requires_valid_room_scoped_token(monkeypatch) -> None:
    from livekit import api
    from app.api.routes import meetings
    from app.services.meeting_service import MeetingSession

    key, secret = "test-key", "test-secret-long-enough-for-signing"
    monkeypatch.setattr(meetings, "get_settings", lambda: SimpleNamespace(livekit_api_key=key, livekit_api_secret=secret))
    first = MeetingSession("ABCDEFGH", "host", record("alice"), Language.mixed)
    second = MeetingSession("JKLMNPQR", "host", record("bob"), Language.mixed)
    first.add_participant("attendee-a", "Guest", False)
    second.add_participant("attendee-b", "Guest", False)
    sessions = {first.code: first, second.code: second}
    monkeypatch.setattr(meetings.meeting_registry, "get", lambda code: sessions.get(code))
    token = (api.AccessToken(key, secret).with_identity("attendee-a")
             .with_grants(api.VideoGrants(room_join=True, room=first.room_name, can_publish=False)).to_jwt())
    expired = (api.AccessToken(key, secret).with_identity("attendee-a")
               .with_ttl(timedelta(seconds=-1))
               .with_grants(api.VideoGrants(room_join=True, room=first.room_name)).to_jwt())
    client = TestClient(app)
    assert client.get(f"/api/meetings/{first.code}/transcript").status_code == 404
    assert client.get(f"/api/meetings/{first.code}/transcript", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.get(f"/api/meetings/{second.code}/transcript", headers={"Authorization": f"Bearer {token}"}).status_code == 404
    assert client.get(f"/api/meetings/{first.code}/transcript", headers={"Authorization": "Bearer forged"}).status_code == 404
    assert client.get(f"/api/meetings/{first.code}/transcript", headers={"Authorization": f"Bearer {expired}"}).status_code == 404
    assert client.get("/api/history", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_join_requires_invitation_and_issues_room_scoped_credential(monkeypatch) -> None:
    from app.api.routes import meetings
    from app.services import meeting_service
    config = SimpleNamespace(livekit_api_key="test-key", livekit_api_secret="test-secret-long-enough-for-signing", livekit_token_minutes=10, livekit_url="wss://example.invalid")
    monkeypatch.setattr(meetings, "get_settings", lambda: config)
    monkeypatch.setattr(meeting_service, "get_settings", lambda: config)
    room = meeting_service.MeetingSession("ABCDEFGH", "host", record("alice"), Language.mixed, organizer_user_id="alice")
    room.started = True
    monkeypatch.setattr(meetings.meeting_registry, "get", lambda code: room if code == room.code else None)

    async def save(value):
        return value
    monkeypatch.setattr(meetings, "save_record", save)
    client = TestClient(app)
    assert client.get(f"/api/meetings/{room.code}").status_code == 404
    assert client.get(f"/api/meetings/{room.code}", headers={"Authorization": f"Invite {room.invitation_secret}"}).status_code == 200
    assert client.post(f"/api/meetings/{room.code}/join", json={"display_name": "Guest", "invitation": "wrong"}).status_code == 404
    assert client.post(f"/api/meetings/{room.code}/join", json={"display_name": "Guest", "invitation": "தவறு"}).status_code == 404
    response = client.post(f"/api/meetings/{room.code}/join", json={"display_name": "Guest", "invitation": room.invitation_secret})
    assert response.status_code == 200
    body = response.json()
    assert body["is_host"] is False
    assert body["host_secret"] is None and body["invitation_secret"] is None
    assert client.get(f"/api/meetings/{room.code}/transcript", headers={"Authorization": f"Bearer {body['token']}"}).status_code == 200
    with client.websocket_connect(f"/api/meetings/{room.code}/audio") as socket:
        socket.send_json({"host_secret": "host", "participant_identity": body["participant_identity"], "token": body["token"]})
        assert socket.receive_json()["type"] == "error"


def test_history_http_access_is_enforced_for_each_user(tmp_path, monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "admin_email", "admin@example.invalid")
    monkeypatch.setattr(settings, "admin_password", "admin-password-123")
    auth_store.__init__()
    monkeypatch.setattr(history, "_loaded", True)
    monkeypatch.setattr(history, "_records", {})
    client = TestClient(app)
    def signup(name):
        email = f"{name}@example.invalid"
        response = client.post("/api/auth/register", json={"name": name, "email": email, "password": "password123"})
        assert response.status_code == 201
        login = client.post("/api/auth/login", json={"email": email, "password": "password123"}).json()
        return login["user"]["id"], {"Authorization": f"Bearer {login['token']}"}

    alice, alice_headers = signup("Alice")
    bob, bob_headers = signup("Bob")
    owned = record(alice)
    other = record(bob)
    legacy = record(None)
    (tmp_path / "audio").mkdir()
    (tmp_path / "audio" / "test.wav").write_bytes(b"test-audio")
    owned.audio_filename = "test.wav"
    history._records.update({item.id: item for item in (owned, other, legacy)})
    admin = client.post("/api/auth/login", json={"email": "admin@example.invalid", "password": "admin-password-123"}).json()
    admin_headers = {"Authorization": f"Bearer {admin['token']}"}

    assert client.get("/api/history").status_code == 401
    with client.websocket_connect("/api/history/events") as socket:
        socket.send_json({"token": "forged"})
        with pytest.raises(Exception) as rejected:
            socket.receive_json()
        assert getattr(rejected.value, "code", None) == 1008
    with client.websocket_connect("/api/live") as socket:
        socket.send_json({"token": "forged", "language": "Mixed", "session_type": "Live"})
        assert socket.receive_json()["type"] == "error"
        with pytest.raises(Exception) as rejected:
            socket.receive_json()
        assert getattr(rejected.value, "code", None) == 1008
    with client.websocket_connect("/api/history/events") as socket:
        socket.send_json({"token": alice_headers["Authorization"].split(" ", 1)[1]})
        assert socket.receive_json()["type"] == "ready"
    assert [item["id"] for item in client.get("/api/history", headers=alice_headers).json()] == [owned.id]
    assert client.get(f"/api/history/{owned.id}", headers=alice_headers).status_code == 200
    assert client.get(f"/api/history/{owned.id}", headers=bob_headers).status_code == 404
    assert client.get(f"/api/history/{legacy.id}", headers=alice_headers).status_code == 404
    assert client.get(f"/api/history/{legacy.id}", headers=admin_headers).status_code == 200
    assert client.get(f"/api/history/{owned.id}/audio").status_code == 401
    assert client.get(f"/api/history/{owned.id}/audio", headers=bob_headers).status_code == 404
    assert client.get(f"/api/history/{owned.id}/audio", headers=alice_headers).content == b"test-audio"
    assert client.delete(f"/api/history/{owned.id}", headers=bob_headers).status_code == 404
    assert client.post(f"/api/transcribe/{owned.id}/cancel", headers=bob_headers).status_code == 404
    assert client.post(f"/api/transcribe/{owned.id}/retry", headers=bob_headers).status_code == 404
    assert owned.id in history._records
    auth_store.__init__()
