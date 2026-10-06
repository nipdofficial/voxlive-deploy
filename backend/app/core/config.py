from functools import lru_cache
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.models.schemas import Language

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_name: str = "HelaScribe API"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_reload: bool = False
    api_prefix: str = "/api"
    allowed_origins: str = "*"
    public_app_url: str = "https://voxlive-deploy-frontend.vercel.app"

    vertex_service_account_json: Path = Path("service_account.json")
    gcp_project: str | None = None
    # Live transcription uses Gemini's persistent Live API WebSocket.
    gcp_location: str = "global"
    # The current transcription service uses Gemini generateContent for
    # overlapping live previews. The live-preview model is reserved for a
    # persistent Live API session and is not valid for generateContent.
    # Gemini Live API uses a different model family from generateContent.
    # The transcribe-preview model is not accepted by the Live API and closes
    # the websocket with INVALID_ARGUMENT/1007.
    gemini_live_model: str = "gemini-3.8-live"
    # Use the generally available multimodal Flash model for live speech.
    # The transcribe preview endpoint was returning RESOURCE_EXHAUSTED for
    # meeting chunks and required a second model call for Tamil translation.
    gemini_batch_model: str = "gemini-3.8-flash"
    gemini_text_model: str = "gemini-3.8-flash"
    auto_translate: bool = True
    target_language: Language = Language.tamil
    gemini_max_retries: int = 3
    gemini_retry_base_seconds: float = 1.0
    gemini_live_timeout_seconds: float = 30.0
    gemini_batch_timeout_seconds: float = 90.0
    # Gemini Live accepts small continuous PCM frames. The retained full
    # recording is still transcribed after Stop for accuracy and diarization.
    live_stream_chunk_ms: int = 100
    # Keep meeting captions responsive: a short window is sent while people
    # speak, while a small overlap still gives Gemini enough sentence context.
    live_chunk_seconds: float = 2.5
    live_chunk_overlap_seconds: float = 0.4
    live_stop_preview_grace_seconds: float = 8.0
    live_preview_queue_size: int = 50
    live_silence_rms_threshold: float = 20.0
    live_finalize_full_audio: bool = True
    max_live_minutes: float = 120.0
    max_upload_mb: int = 20

    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None
    livekit_token_minutes: int = 120

    huggingface_token: str | None = None
    pyannote_model: str = "pyannote/speaker-diarization-community-1"
    data_dir: Path = Path("data")
    sentry_dsn: str | None = None
    app_environment: str = "development"

    # Administrator sign-in. Admin login is disabled until both are set.
    admin_email: str | None = None
    admin_password: str | None = None
    auth_session_hours: float = 24.0

    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    @model_validator(mode="after")
    def enforce_tamil_translation_target(self) -> "Settings":
        """Keep deployment/environment overrides from selecting another target."""
        self.target_language = Language.tamil
        # Older Render environments may retain legacy IDs after a Blueprint
        # update. Use the 3.8 Live API model, never a generateContent/transcribe
        # model or a 2.5 Live model, for the persistent streaming connection.
        if "transcribe" in self.gemini_live_model.lower() or self.gemini_live_model in {
            "gemini-live-2.5-flash-native-audio",
            "gemini-2.5-flash-native-audio-preview-12-2025",
        }:
            self.gemini_live_model = "gemini-3.8-live"
        if self.gemini_batch_model in {
            "gemini-2.5-flash",
            "gemini-3.5-flash",
            "gemini-3.5-transcribe-preview",
        }:
            self.gemini_batch_model = "gemini-3.8-flash"
        if self.gemini_text_model in {
            "gemini-2.5-flash",
            "gemini-3.5-flash",
            "gemini-3.5-transcribe-preview",
        }:
            self.gemini_text_model = "gemini-3.8-flash"
        return self

    @property
    def origins(self) -> list[str]:
        if self.allowed_origins.strip() == "*":
            return ["*"]
        return [item.strip() for item in self.allowed_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if not settings.vertex_service_account_json.is_absolute():
        settings.vertex_service_account_json = (
            BACKEND_DIR / settings.vertex_service_account_json
        ).resolve()
    if not settings.data_dir.is_absolute():
        settings.data_dir = (BACKEND_DIR / settings.data_dir).resolve()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "audio").mkdir(parents=True, exist_ok=True)
    return settings
