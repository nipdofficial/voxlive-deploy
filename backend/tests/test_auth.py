import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.services.auth_service import auth_store, hash_password, verify_password

ADMIN_EMAIL = "admin@example.com"
ADMIN_PASSWORD = "admin-secret-123"


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    settings = get_settings()
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "admin_email", ADMIN_EMAIL)
    monkeypatch.setattr(settings, "admin_password", ADMIN_PASSWORD)
    auth_store.__init__()
    yield TestClient(app)
    auth_store.__init__()


def _register(client: TestClient, email: str = "anu@example.com", password: str = "password123"):
    return client.post(
        "/api/auth/register", json={"name": "Anu", "email": email, "password": password}
    )


def _login(client: TestClient, email: str, password: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["token"]


def test_password_hash_round_trip() -> None:
    encoded = hash_password("correct horse")
    assert "correct horse" not in encoded
    assert verify_password("correct horse", encoded)
    assert not verify_password("wrong", encoded)


def test_user_must_register_before_login(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login", json={"email": "anu@example.com", "password": "password123"}
    )
    assert response.status_code == 401

    registered = _register(client)
    assert registered.status_code == 201
    assert registered.json()["role"] == "user"
    assert "password_hash" not in registered.json()

    token = _login(client, "ANU@example.com ", "password123")
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json()["email"] == "anu@example.com"


def test_registration_validation(client: TestClient) -> None:
    assert _register(client, password="short").status_code == 400
    assert _register(client, email="not-an-email").status_code == 400
    assert _register(client).status_code == 201
    assert _register(client).status_code == 409
    assert _register(client, email=ADMIN_EMAIL).status_code == 409


def test_wrong_password_is_rejected_and_rate_limited(client: TestClient) -> None:
    _register(client)
    for _ in range(5):
        response = client.post(
            "/api/auth/login", json={"email": "anu@example.com", "password": "nope-nope"}
        )
        assert response.status_code == 401
    response = client.post(
        "/api/auth/login", json={"email": "anu@example.com", "password": "password123"}
    )
    assert response.status_code == 429


def test_admin_dashboard_requires_admin_role(client: TestClient) -> None:
    assert client.get("/api/admin/overview").status_code == 401

    _register(client)
    user_token = _login(client, "anu@example.com", "password123")
    user_headers = {"Authorization": f"Bearer {user_token}"}
    assert client.get("/api/admin/overview", headers=user_headers).status_code == 403

    admin_token = _login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    overview = client.get("/api/admin/overview", headers=admin_headers).json()
    assert overview["total_users"] == 1
    assert overview["signed_in_users"] == 1
    assert overview["users"][0]["online"] is True
    assert {session["role"] for session in overview["sessions"]} == {"user", "admin"}

    user_session = next(s for s in overview["sessions"] if s["role"] == "user")
    revoked = client.delete(f"/api/admin/sessions/{user_session['id']}", headers=admin_headers)
    assert revoked.status_code == 204
    assert client.get("/api/auth/me", headers=user_headers).status_code == 401


def test_logout_ends_session_and_state_survives_restart(client: TestClient) -> None:
    _register(client)
    token = _login(client, "anu@example.com", "password123")
    headers = {"Authorization": f"Bearer {token}"}

    auth_store.__init__()  # Simulate an API restart: reload from disk.
    assert client.get("/api/auth/me", headers=headers).status_code == 200

    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_admin_login_disabled_without_password(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "admin_password", None)
    response = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ""})
    assert response.status_code == 401
