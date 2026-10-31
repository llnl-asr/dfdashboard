"""Provenance graph API."""

from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from ..core.errors import NO_SUCH_RUN, ApiError
from ..data.prov_stream import feed_for
from ..data.prov_types import ProvGraph
from ..runtime.pool import pools
from ..trace import TraceData
from .cache import LRUCache
from .deps import get_registry, get_trace

router = APIRouter(prefix="/api", tags=["prov"])
_cache = LRUCache(maxsize=8)
_POLL_S = 0.5
_KEEPALIVE_S = 15.0


@router.get("/prov/graph")
async def prov_graph(
    io: int = Query(1, ge=0, le=1),
    all_files: int = Query(0, ge=0, le=1),
    mounts: str = "",
    trace: TraceData = Depends(get_trace),
) -> ProvGraph:
    extra = tuple(m for m in (p.strip() for p in mounts.split(",")) if m)
    key = (trace.cache_key, "prov", io, all_files, extra)

    async def build() -> ProvGraph:
        return await pools().run_compute(
            trace.provenance,
            include_io=bool(io),
            include_all_files=bool(all_files),
            mounts=extra,
        )

    return await _cache.get_or_set(key, build)


def _run_paths(request: Request, run: str) -> list[str]:
    """Where the run's traces are. A run still being written has no index yet, so this
    reads the tree, not the trace layer."""
    registry = get_registry(request)
    if registry is not None:
        if not run:
            return [registry.root]
        path = os.path.abspath(os.path.join(registry.root, run))
        if not path.startswith(os.path.abspath(registry.root) + os.sep) or not os.path.isdir(path):
            raise ApiError(404, NO_SUCH_RUN, f"no run: {run}")
        return [path]
    trace = getattr(request.app.state, "trace", None)
    return list(getattr(trace, "files", None) or [])


@router.get("/prov/stream")
async def prov_stream(request: Request, run: str = "") -> StreamingResponse:
    """Server-sent events: a ``snapshot`` of the graph, then a ``delta`` per change, while
    the trace grows."""
    if not hasattr(request.app.state, "prov_feeds"):
        request.app.state.prov_feeds = {}
    feeds = request.app.state.prov_feeds
    feed = feed_for(feeds, run, _run_paths(request, run))

    async def frames() -> AsyncIterator[str]:
        if feed is None:
            yield "event: snapshot\ndata: {}\n\n"
            return
        await asyncio.to_thread(feed.poll)
        snap = feed.snapshot()
        seq, quiet = snap["seq"], 0.0
        yield f"event: snapshot\ndata: {json.dumps(snap)}\n\n"
        while not await request.is_disconnected():
            await asyncio.to_thread(feed.poll)
            items, seq = feed.since(seq)
            if items:
                quiet = 0.0
                yield f"event: delta\ndata: {json.dumps({'seq': seq, 'items': items})}\n\n"
                continue
            await asyncio.sleep(_POLL_S)
            quiet += _POLL_S
            if quiet >= _KEEPALIVE_S:
                quiet = 0.0
                yield ": keep-alive\n\n"

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
