from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from app.core.origin_verification import OriginVerificationMiddleware


def make_client(secret):
    app = FastAPI()
    app.add_middleware(OriginVerificationMiddleware, secret=secret)

    @app.get("/test")
    async def endpoint():
        return {"ok": True}

    @app.websocket("/ws")
    async def socket(ws: WebSocket):
        await ws.accept()
        await ws.send_text("ok")
        await ws.close()

    return TestClient(app)


def test_http_origin_secret_enforced_and_duplicates_rejected():
    client = make_client("test-secret")
    assert client.get("/test").status_code == 403
    assert client.get("/test", headers={"x-voxlive-origin": "wrong"}).status_code == 403
    assert client.get("/test", headers=[("x-voxlive-origin", "test-secret"), ("x-voxlive-origin", "wrong")]).status_code == 403
    assert client.get("/test", headers={"x-voxlive-origin": "test-secret"}).status_code == 200


def test_websocket_origin_secret_enforced():
    client = make_client("test-secret")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"x-voxlive-origin": "wrong"}):
            pass
    with client.websocket_connect("/ws", headers={"x-voxlive-origin": "test-secret"}) as ws:
        assert ws.receive_text() == "ok"


def test_disabled_allows_existing_development_configuration():
    assert make_client(None).get("/test").status_code == 200
