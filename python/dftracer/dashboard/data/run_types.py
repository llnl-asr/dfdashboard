"""What a run looks like over the API: one run, and the whole snapshot."""

from __future__ import annotations

from typing import TypedDict


class RunDict(TypedDict):
    id: str
    dir: str
    format: str
    state: str
    reason: str
    version: int
    files: int
    bytes: int
    events: int
    first_ts: int
    last_ts: int


class Snapshot(TypedDict):
    root: str
    watch: str
    seq: int
    runs: list[RunDict]


class EventRow(TypedDict):
    """One event as the JSON API serves it: envelope, plus the resolved args."""

    name: str
    cat: str
    pid: int
    tid: int
    ts: int
    dur: int
    ph: str
    agg: bool
    count: int
    total: int
    args: dict[str, str]


class UntimedPayload(TypedDict):
    events: list[EventRow]
    count: int
    offset: int
    limit: int
