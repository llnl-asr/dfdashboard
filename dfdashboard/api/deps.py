from __future__ import annotations

import os

from fastapi import HTTPException, Request

from ..data.trace import TraceData
from ..runtime import EventBus, InProcessTaskBackend


def get_index_dir(request: Request) -> str:
    return getattr(request.app.state, "index_dir", None) or os.path.expanduser(
        "~/.cache/dfdashboard/index"
    )


def get_trace(request: Request) -> TraceData:
    trace = request.app.state.trace
    if trace is None:
        raise HTTPException(status_code=503, detail="no trace loaded")
    return trace


def get_n_files(request: Request) -> int:
    return request.app.state.n_files


def get_backend(request: Request) -> InProcessTaskBackend:
    return request.app.state.backend


def get_events(request: Request) -> EventBus:
    return request.app.state.events


def get_cluster(request: Request):
    return getattr(request.app.state, "cluster", None)
