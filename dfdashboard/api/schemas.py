"""Response models for the viz API."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class TimeRange(BaseModel):
    min_timestamp_us: int
    max_timestamp_us: int


class Info(BaseModel):
    file_count: int
    num_events: int = 0
    global_min_timestamp_us: int = 0
    global_max_timestamp_us: int = 0
    total_bytes: int = 0
    total_io_busy: int = 0
    io_share: float = 0.0
    time_range: Optional[TimeRange] = None


class ProcNode(BaseModel):
    pid: int
    parent: int = -1
    spawn_ts: int = 0
    first_ts: int = 0
    host: str = ""
    rank: str = ""
    bytes: int = 0
    io_ops: int = 0
    io_busy: int = 0


class ProcTree(BaseModel):
    nodes: list[ProcNode]


class NameStat(BaseModel):
    name: str
    count: int
    total: int
    avg: float
    min: int
    max: int


class Stats(BaseModel):
    count: int
    total_dur: int
    wall: int
    truncated: bool = False
    names: list[NameStat]


class Breaks(BaseModel):
    gaps: list[dict[str, Any]]
    multi_run: bool


class Layers(BaseModel):
    layers: dict[str, str]
    total_files: int
    io_files: int
