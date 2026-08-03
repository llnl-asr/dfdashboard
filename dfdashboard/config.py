"""Runtime configuration. `embedded` and `service` are presets over the same
knobs, not separate code paths.
"""

from __future__ import annotations

from enum import Enum

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Preset(str, Enum):
    EMBEDDED = "embedded"
    SERVICE = "service"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DFDASHBOARD_")

    preset: Preset = Preset.EMBEDDED
    trace_paths: list[str] = Field(default_factory=list)

    scheduler_address: str | None = None  # None spawns and owns a LocalCluster
    store_url: str | None = None  # None keeps the store in memory
    auth: bool = False
    idle_timeout_s: int | None = 900  # None runs until stopped

    host: str = "127.0.0.1"
    port: int = 5006
    web_dist: str | None = None  # directory holding the frontend index.html
    index_dir: str | None = None  # None -> a persistent per-user cache dir

    @classmethod
    def for_preset(cls, preset: Preset, **overrides) -> "Settings":
        base: dict = {"preset": preset}
        if preset is Preset.SERVICE:
            base.update(auth=True, idle_timeout_s=None)
        base.update(overrides)
        return cls(**base)
