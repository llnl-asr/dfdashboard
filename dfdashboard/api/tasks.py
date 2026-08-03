"""Analysis API: list pipelines, submit tasks, watch them, cancel."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..analysis.base import list_pipelines
from ..runtime import EventBus, InProcessTaskBackend, TaskSpec, TaskState
from .deps import get_backend, get_events

router = APIRouter(prefix="/api", tags=["analysis"])

_TERMINAL = {s.value for s in (TaskState.DONE, TaskState.FAILED, TaskState.CANCELLED)}


@router.get("/pipelines")
async def pipelines() -> list[dict[str, Any]]:
    return [p.describe() for p in list_pipelines() if not p.internal]


@router.post("/tasks")
async def submit(spec: TaskSpec, backend: InProcessTaskBackend = Depends(get_backend)) -> dict:
    return {"task_id": await backend.submit(spec)}


@router.get("/tasks")
async def tasks(backend: InProcessTaskBackend = Depends(get_backend)) -> list[dict[str, Any]]:
    return [r.to_dict() for r in backend.records()]


@router.get("/tasks/{task_id}")
async def task(
    task_id: str, backend: InProcessTaskBackend = Depends(get_backend)
) -> dict[str, Any]:
    rec = backend.get(task_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="unknown task")
    d = rec.to_dict()
    if rec.result is not None:
        d["result"] = {"data": rec.result.data, "meta": rec.result.meta}
    return d


@router.delete("/tasks/{task_id}")
async def cancel(task_id: str, backend: InProcessTaskBackend = Depends(get_backend)) -> dict:
    return {"cancelled": await backend.cancel(task_id)}


@router.get("/tasks/{task_id}/events")
async def events(
    task_id: str,
    request: Request,
    backend: InProcessTaskBackend = Depends(get_backend),
    bus: EventBus = Depends(get_events),
) -> StreamingResponse:
    rec = backend.get(task_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="unknown task")

    async def stream():
        yield f"data: {json.dumps(rec.to_dict())}\n\n"
        if rec.state.value in _TERMINAL:
            return
        async for _topic, payload in bus.subscribe("task"):
            if await request.is_disconnected():
                break
            if payload.get("task_id") != task_id:
                continue
            yield f"data: {json.dumps(payload)}\n\n"
            if payload.get("state") in _TERMINAL:
                break

    return StreamingResponse(stream(), media_type="text/event-stream")
