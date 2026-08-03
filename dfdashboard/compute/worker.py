"""Dask-worker side of card compute.

The trace handle is unpicklable, so it is never shipped to a worker: a
same-process worker reads it from `_TRACE`, a remote one rebuilds it from the
index directory (cached per worker).
"""

from __future__ import annotations

from typing import Any, Optional

_TRACE: Any = None
_REBUILT: dict[str, Any] = {}


def set_worker_trace(trace: Any) -> None:
    global _TRACE
    _TRACE = trace


def _trace_for(index_dir: str, files: Optional[list[str]]) -> Any:
    if _TRACE is not None:
        return _TRACE
    if not index_dir or not files:
        raise RuntimeError("no worker trace registered and no index to rebuild from")
    key = index_dir + "|" + ",".join(files)
    trace = _REBUILT.get(key)
    if trace is None:
        from ..data.trace import TraceData

        trace = TraceData(files, index_dir=index_dir)
        _REBUILT[key] = trace
    return trace


def dispatch_op(
    trace: Any, op: str, begin: float, end: float, query: Optional[str], n: int, nbuckets: int
) -> Any:
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
) -> Any:
    return dispatch_op(_trace_for(index_dir, files), op, begin, end, query, n, nbuckets)
