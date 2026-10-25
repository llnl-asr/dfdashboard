"""Response models for the viz API.

The stats and breaks payloads are the question TypedDicts themselves, so there is
one definition and FastAPI validates against it.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel
from typing_extensions import TypedDict

from ..data.run_types import EventRow


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


class Layers(BaseModel):
    layers: dict[str, str]
    total_files: int
    io_files: int


class EventWindow(BaseModel):
    begin: float
    end: float
    count: int


class EventsPayload(TypedDict):
    events: list[EventRow]
    metadata: EventWindow
