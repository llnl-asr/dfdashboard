from __future__ import annotations

import os
from typing import Optional

from fastapi import Request

from ..core.errors import NO_SUCH_FILE, NO_SUCH_RUN, NO_TRACE_YET, ApiError
from ..data.trace import TraceData
from ..data.watch import RunRegistry
from ..runtime import EventBus, InProcessTaskBackend


def get_index_dir(request: Request) -> str:
    return getattr(request.app.state, "index_dir", None) or os.path.expanduser(
        "~/.cache/dfdashboard/index"
    )


def get_registry(request: Request) -> Optional[RunRegistry]:
    return getattr(request.app.state, "registry", None)


def get_trace(request: Request) -> TraceData:
    """The loaded trace, scoped to ``?run=`` and ``?file=`` when given."""
    registry: Optional[RunRegistry] = get_registry(request)
    trace: Optional[TraceData] = (
        registry.trace() if registry is not None else request.app.state.trace
    )
    run = request.query_params.get("run", "")
    file = request.query_params.get("file", "")
    cache: dict[tuple[str, str, str], TraceData] = request.app.state.scoped_traces
    if registry is not None:
        # A new file set invalidates every scope taken from the old one.
        if request.app.state.scoped_seq != registry.seq:
            cache.clear()
            request.app.state.scoped_seq = registry.seq
    if run:
        if registry is None:
            raise ApiError(404, NO_SUCH_RUN, f"no run: {run}")
        if ("run", run, "") not in cache:
            try:
                cache[("run", run, "")] = registry.trace_for(run)
            except KeyError as exc:
                raise ApiError(404, NO_SUCH_RUN, f"no run: {run}") from exc
        trace = cache[("run", run, "")]
    if trace is None:
        raise ApiError(503, NO_TRACE_YET, "no trace data yet, waiting for the first records")
    if not file:
        return trace
    key = ("file", run, file)
    if key not in cache:
        try:
            cache[key] = trace.scoped(file)
        except KeyError as exc:
            raise ApiError(404, NO_SUCH_FILE, f"no trace file: {file}") from exc
    return cache[key]


def get_n_files(request: Request) -> int:
    """Size of the loaded set: a run when ``?run=`` is given, else everything."""
    registry: Optional[RunRegistry] = get_registry(request)
    if registry is None:
        return request.app.state.n_files
    run = request.query_params.get("run", "")
    if not run:
        return registry.n_files()
    try:
        return registry.n_files_for(run)
    except KeyError as exc:
        raise ApiError(404, NO_SUCH_RUN, f"no run: {run}") from exc


def get_backend(request: Request) -> InProcessTaskBackend:
    return request.app.state.backend


def get_events(request: Request) -> EventBus:
    return request.app.state.events


def get_cluster(request: Request):
    return getattr(request.app.state, "cluster", None)
