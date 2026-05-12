from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    pageindex_api_key: str
    data_dir: Path
    poll_interval_seconds: float
    processing_timeout_seconds: float
    require_pageindex_citations: bool

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def converted_dir(self) -> Path:
        return self.data_dir / "converted"

    @property
    def state_dir(self) -> Path:
        return self.data_dir / "state"

    @property
    def manifest_path(self) -> Path:
        return self.state_dir / "documents.json"

    def ensure_dirs(self) -> None:
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.converted_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    load_dotenv()
    data_dir = Path(os.getenv("DATA_DIR", "data")).resolve()
    settings = Settings(
        pageindex_api_key=os.getenv("PAGEINDEX_API_KEY", "").strip(),
        data_dir=data_dir,
        poll_interval_seconds=float(os.getenv("PAGEINDEX_POLL_INTERVAL_SECONDS", "3")),
        processing_timeout_seconds=float(os.getenv("PAGEINDEX_PROCESSING_TIMEOUT_SECONDS", "900")),
        require_pageindex_citations=_env_bool("REQUIRE_PAGEINDEX_CITATIONS", True),
    )
    settings.ensure_dirs()
    return settings
