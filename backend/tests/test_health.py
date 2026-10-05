import asyncio
from pathlib import Path
from types import SimpleNamespace

from app import main


def test_health_reports_degraded_when_vertex_credentials_are_missing(monkeypatch, tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    credentials = tmp_path / "service-account.json"
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            data_dir=tmp_path,
            vertex_service_account_json=credentials,
            livekit_url=None,
            livekit_api_key=None,
            livekit_api_secret=None,
        ),
    )
    result = asyncio.run(main.health())

    assert result["status"] == "degraded"
    assert result["ready"] is False
    assert result["checks"]["storage"] is True
    assert result["checks"]["vertex_credentials"] is False


def test_health_is_ready_when_core_dependencies_are_available(monkeypatch, tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    credentials = tmp_path / "service-account.json"
    credentials.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            data_dir=tmp_path,
            vertex_service_account_json=credentials,
            livekit_url="wss://example.livekit.cloud",
            livekit_api_key="key",
            livekit_api_secret="secret",
        ),
    )
    result = asyncio.run(main.health())

    assert result["status"] == "ok"
    assert result["ready"] is True
    assert result["checks"]["livekit_configured"] is True
