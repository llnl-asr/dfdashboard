"""Log console API: recent buffer, known groups, and a live SSE stream."""

from __future__ import annotations

import asyncio
import json
from enum import Enum

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..runtime.logs import get_hub

router = APIRouter(prefix="/api", tags=["logs"])


class NativeLevel(str, Enum):
    trace = "trace"
    debug = "debug"
    info = "info"
    warn = "warn"
    error = "error"
    off = "off"


@router.get("/logs/native-level")
async def native_level() -> dict:
    levels = [e.value for e in NativeLevel]
    try:
        import dftracer.utils as u

        return {"level": u.get_log_level(), "levels": levels}
    except Exception:
        return {"level": None, "levels": levels}


@router.post("/logs/native-level")
async def set_native_level(level: NativeLevel) -> dict:
    import dftracer.utils as u

    u.set_log_level(level.value)
    return {"level": u.get_log_level()}


def _match(rec: dict, level: int, groups: set[str]) -> bool:
    return rec["levelno"] >= level and (not groups or rec["group"] in groups)


@router.get("/logs")
async def logs(level: int = 0, group: str = "", limit: int = 500) -> list[dict]:
    groups = {g for g in group.split(",") if g}
    recs = [r for r in get_hub().snapshot() if _match(r, level, groups)]
    return recs[-limit:]


@router.get("/logs/groups")
async def groups() -> list[str]:
    return get_hub().groups()


@router.get("/logs/stream")
async def stream(request: Request, level: int = 0, group: str = "") -> StreamingResponse:
    hub = get_hub()
    groups = {g for g in group.split(",") if g}

    async def gen():
        for rec in hub.snapshot():  # full buffer, so early startup logs are not lost
            if _match(rec, level, groups):
                yield f"data: {json.dumps(rec)}\n\n"
        q = hub.add_subscriber()
        try:
            while not await request.is_disconnected():
                try:
                    rec = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if rec is None:
                    break  # shutdown sentinel
                if _match(rec, level, groups):
                    yield f"data: {json.dumps(rec)}\n\n"
        finally:
            hub.remove_subscriber(q)

    return StreamingResponse(gen(), media_type="text/event-stream")
