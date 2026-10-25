"""Dask-worker side of card compute.

The trace handle is unpicklable, so it is never shipped to a worker: a
same-process worker reads it from `_TRACE`, a remote one rebuilds it from the
index directory (cached per worker).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional, Union

from ..trace.counters import SeriesPayload
from ..trace.questions.types import (
    AccessPatternPayload,
    HistogramPayload,
    OpStatsPayload,
    ProcBytesPayload,
    SizeHistogramPayload,
)

if TYPE_CHECKING:
    from ..trace import TraceData

_TRACE: Optional[TraceData] = None
_REBUILT: dict[str, TraceData] = {}


def set_worker_trace(trace: Optional[TraceData]) -> None:
    global _TRACE
    _TRACE = trace


def _trace_for(index_dir: str, files: Optional[list[str]]) -> TraceData:
    if _TRACE is not None and (not files or list(_TRACE.paths) == files):
        return _TRACE
    if not index_dir or not files:
        raise RuntimeError("no worker trace registered and no index to rebuild from")
    key = index_dir + "|" + ",".join(files)
    trace = _REBUILT.get(key)
    if trace is None:
        from ..trace import trace_data

        trace = trace_data(files, index_dir=index_dir)
        _REBUILT[key] = trace
    return trace


CardAnswer = Union[
    OpStatsPayload,
    HistogramPayload,
    SizeHistogramPayload,
    AccessPatternPayload,
    ProcBytesPayload,
    SeriesPayload,
    bytes,
]


def dispatch_op(
    trace: TraceData,
    op: str,
    begin: float,
    end: float,
    query: Optional[str],
    n: int,
    nbuckets: int,
) -> CardAnswer:
    if op == "op_stats":
        return trace.op_stats(begin, end, query)
    if op == "counters":
        return trace.counters_arrow(begin, end, n, query)
    if op == "histogram":
        return trace.histogram(begin, end, query, n)
    if op == "size_histogram":
        return trace.size_histogram(begin, end, query, nbuckets)
    if op == "access_pattern":
        return trace.access_pattern(begin, end, query)
    if op == "proc_bytes":
        return trace.proc_bytes(begin, end, query)
    raise ValueError(f"unknown card op: {op}")


def worker_compute(
    op: str,
    begin: float,
    end: float,
    query: Optional[str],
    n: int,
    nbuckets: int,
    index_dir: str = "",
    files: Optional[list[str]] = None,
) -> CardAnswer:
    return dispatch_op(_trace_for(index_dir, files), op, begin, end, query, n, nbuckets)
