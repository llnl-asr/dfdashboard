"""The payload of every question, so a shape's return type is a real type.

These describe the dicts the shapes build. The API's pydantic models are the
wire copy; a payload change is a change here first.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from ...data._calltree import TreeNode


class OpStatRow(TypedDict):
    time: float
    count: int
    bytes: int


class AccessPatternPayload(TypedDict):
    sequential: int
    random: int
    seeks: int
    method: Literal["none", "offset", "seek"]


class ProcBytesRow(TypedDict):
    pid: int
    host: str
    bytes: int
    time_us: float
    count: int


class Bucket(TypedDict):
    lo: float
    hi: float
    count: int


class HistogramPayload(TypedDict):
    count: int
    min: float
    max: float
    mean: float
    p50: float
    p90: float
    p95: float
    p99: float
    truncated: bool
    buckets: list[Bucket]


class SizeHistogramPayload(TypedDict):
    count: int
    buckets: list[Bucket]


class NameStatRow(TypedDict):
    name: str
    count: int
    total: int
    avg: float
    min: int
    max: int


class StatsPayload(TypedDict):
    count: int
    total_dur: int
    wall: int
    truncated: bool
    names: list[NameStatRow]


class CalltreePayload(TypedDict):
    truncated: bool
    tree: TreeNode


class Gap(TypedDict):
    begin: int
    end: int


class BreaksPayload(TypedDict):
    gaps: list[Gap]
    multi_run: bool
    valid_start: int
    valid_end: int
    max_life: int


OpStatsPayload = dict[str, OpStatRow]
ProcBytesPayload = list[ProcBytesRow]
