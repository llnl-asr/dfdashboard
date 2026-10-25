"""Live trace runs: the directory tree being watched, and a stream of changes."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..core.errors import NOT_WATCHING, ApiError
from ..data.run_types import Snapshot
from ..data.watch import RunRegistry
from .deps import get_registry

router = APIRouter(prefix="/api", tags=["runs"])
log = logging.getLogger(__name__)

_KEEPALIVE_S = 15.0


def _snapshot(registry: RunRegistry) -> Snapshot:
    try:
        return registry.snapshot()
    except Exception as exc:
        log.warning("run snapshot failed: %s", exc)
        return Snapshot(root=registry.root, watch="", seq=registry.seq, runs=[])


@router.get("/runs")
async def runs(registry: Optional[RunRegistry] = Depends(get_registry)) -> Snapshot:
    reg = registry
    if reg is None:
        return Snapshot(root="", watch="", seq=0, runs=[])
    return await asyncio.to_thread(_snapshot, reg)


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    """Server-sent events: one ``runs`` frame per change, keep-alive otherwise."""
    reg = get_registry(request)
    if reg is None:
        raise ApiError(503, NOT_WATCHING, "not watching a directory")

    async def frames() -> AsyncIterator[str]:
        loop = asyncio.get_running_loop()
        woken = asyncio.Event()

        def notify(_seq: int) -> None:
            loop.call_soon_threadsafe(woken.set)

        drop = reg.add_listener(notify)
        try:
            last = -1
            while True:
                if await request.is_disconnected():
                    break
                seq = reg.seq
                if seq != last:
                    last = seq
                    snap = await asyncio.to_thread(_snapshot, reg)
                    yield f"event: runs\ndata: {json.dumps(snap)}\n\n"
                    continue
                woken.clear()
                try:
                    await asyncio.wait_for(woken.wait(), timeout=_KEEPALIVE_S)
                except (asyncio.TimeoutError, TimeoutError):
                    yield ": keep-alive\n\n"
        finally:
            drop()

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
    )
