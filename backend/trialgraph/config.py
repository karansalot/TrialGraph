"""Runtime configuration. Every value can be overridden with a TG_* environment variable."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TG_", env_file=REPO_ROOT / ".env", extra="ignore")

    database_url: str = "postgresql+psycopg://trialgraph:trialgraph@localhost:5433/trialgraph"
    data_dir: Path = REPO_ROOT / "data"
    acs_year: int = 2024
    boundary_year: int = 2023
    pilot_states: str = ""  # comma-separated USPS codes; empty = 50 states + DC
    osrm_url: str = ""  # optional routing source; empty = straight-line distance only
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3010,http://127.0.0.1:3010"
    # Data older than this many days is flagged "stale" by the freshness check.
    ctgov_stale_after_days: int = 14

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    @property
    def pilot_state_list(self) -> list[str]:
        return [s.strip().upper() for s in self.pilot_states.split(",") if s.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
