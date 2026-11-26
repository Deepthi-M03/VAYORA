"""Settings loaded from environment / .env. Secrets never live in the frontend."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "VAYORA"
    ENV: str = "development"
    DATABASE_URL: str = "postgresql+psycopg://vayora:vayora@localhost:5432/vayora"
    REDIS_URL: str = "redis://localhost:6379/0"
    CORS_ORIGINS: str = "http://localhost:5173"

    JWT_SECRET: str = "change-me"
    JWT_ACCESS_MINUTES: int = 30
    JWT_REFRESH_DAYS: int = 14
    QUOTE_SECRET: str = "change-me-too"

    GOOGLE_CLIENT_ID: str = ""            # Google sign-in (ID token verification)
    GOOGLE_MAPS_API_KEY: str = ""         # server-side Distance Matrix / Places
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-2.5-flash"

    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""
    RAZORPAY_WEBHOOK_SECRET: str = ""
    RAZORPAYX_ACCOUNT_NUMBER: str = ""    # payouts

    TELEPHONY_PROVIDER: str = "mock"      # mock | exotel
    EXOTEL_SID: str = ""
    EXOTEL_API_KEY: str = ""
    EXOTEL_API_TOKEN: str = ""
    EXOTEL_SUBDOMAIN: str = "api.exotel.com"
    EXOTEL_VIRTUAL_NUMBERS: str = ""      # comma-separated pool

    FCM_CREDENTIALS_FILE: str = ""
    UPLOAD_DIR: str = "./uploads"
    CALL_RECORDING_ENABLED: bool = False  # keep off unless legally cleared and disclosed

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.ENV == "production" and ("change-me" in s.JWT_SECRET or "change-me" in s.QUOTE_SECRET):
        raise RuntimeError("Set JWT_SECRET and QUOTE_SECRET before running in production")
    return s
