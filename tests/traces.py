"""Trace fixtures: every test that needs a trace writes one through here.

Line-delimited JSON only: dftracer reads one record per line and a JSON array
wrapper makes the whole file invisible to it.
"""

from __future__ import annotations

import gzip
import json
import os
from typing import Any, Iterable, Union

Record = Union[str, dict[str, Any]]


def write_trace(directory: Any, records: Iterable[Record], name: str = "t.pfw.gz") -> str:
    """Write one record per line and return the file path."""
    lines = [r if isinstance(r, str) else json.dumps(r) for r in records]
    path = os.path.join(str(directory), name)
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def posix(
    n: int = 5,
    *,
    pid: int = 1,
    start: int = 1_000_000,
    step: int = 100,
    dur: int = 10,
    name: str = "read",
    **args: Any,
) -> list[dict[str, Any]]:
    """`n` POSIX events on one pid, `step` apart."""
    return [
        {
            "name": name,
            "cat": "POSIX",
            "pid": pid,
            "tid": pid,
            "ts": start + i * step,
            "dur": dur,
            "ph": "X",
            "args": args,
        }
        for i in range(n)
    ]


def meta(name: str, args: dict[str, Any], *, pid: int = 1, tid: int = 1) -> dict[str, Any]:
    """A metadata record: what the trace says about a host, file or process."""
    return {"name": name, "cat": "dftracer", "pid": pid, "tid": tid, "ph": "M", "args": args}


def event(
    name: str,
    ts: int,
    dur: int,
    *,
    cat: str = "APP",
    pid: int = 1,
    tid: int = 1,
    **args: Any,
) -> dict[str, Any]:
    return {
        "name": name,
        "cat": cat,
        "pid": pid,
        "tid": tid,
        "ts": ts,
        "dur": dur,
        "ph": "X",
        "args": args,
    }


def multirun(
    directory: Any,
    num_runs: int = 3,
    run_us: int = 1_000_000,
    gap_us: int = 10_000,
    name: str = "multirun.pfw.gz",
) -> str:
    """Several runs of one process each, `gap_us` apart.

    Each run is a start record, three reads and an end record carrying
    `num_events`, which is what the engine reads as an app span.
    """
    base = 1_000_000_000
    records: list[dict[str, Any]] = []
    for r in range(num_runs):
        pid = 100 + r
        start = base + r * (run_us + gap_us)
        records.append(
            event("start", start, 1, cat="dftracer", pid=pid, tid=pid * 10, exec_hash="app", ppid=1)
        )
        records.extend(posix(3, pid=pid, start=start, step=run_us // 4, dur=100, ret=1024))
        records.append(
            event("end", start + run_us, 1, cat="dftracer", pid=pid, tid=pid * 10, num_events=3)
        )
    return write_trace(directory, records, name)
