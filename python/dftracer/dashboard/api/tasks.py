"""Analysis API: list pipelines, submit tasks, watch them, cancel."""

from __future__ import annotations

import json
from typing import Mapping

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..analysis.base import list_pipelines
from ..core.errors import UNKNOWN_TASK, ApiError
from ..runtime import EventBus, InProcessTaskBackend, TaskSpec, TaskState
from ..runtime.tasks import TaskDetail, TaskDict, TaskResultBody
from .deps import get_backend, get_events

router = APIRouter(prefix="/api", tags=["analysis"])

_TERMINAL = {s.value for s in (TaskState.DONE, TaskState.FAILED, TaskState.CANCELLED)}


@router.get("/pipelines")
async def pipelines() -> list[dict[str, object]]:
    return [p.describe() for p in list_pipelines() if not p.internal]


@router.post("/tasks")
async def submit(spec: TaskSpec, backend: InProcessTaskBackend = Depends(get_backend)) -> dict:
    return {"task_id": await backend.submit(spec)}


@router.get("/tasks")
async def tasks(
    backend: InProcessTaskBackend = Depends(get_backend),
) -> list[TaskDict]:
    return [r.to_dict() for r in backend.records()]


@router.get("/tasks/{task_id}")
async def task(task_id: str, backend: InProcessTaskBackend = Depends(get_backend)) -> TaskDetail:
    rec = backend.get(task_id)
    if rec is None:
        raise ApiError(404, UNKNOWN_TASK, "unknown task")
    d = rec.to_dict()
    if rec.result is None:
        raise ApiError(404, UNKNOWN_TASK, "no result yet")
    return {**d, "result": TaskResultBody(data=rec.result.data, meta=rec.result.meta)}


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
        raise ApiError(404, UNKNOWN_TASK, "unknown task")

    async def stream():
        yield f"data: {json.dumps(rec.to_dict())}\n\n"
        if rec.state.value in _TERMINAL:
            return
        async for _topic, payload in bus.subscribe("task"):
            if await request.is_disconnected():
                break
            event: Mapping[str, object] = payload if isinstance(payload, Mapping) else {}
            if event.get("task_id") != task_id:
                continue
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("state") in _TERMINAL:
                break

    return StreamingResponse(stream(), media_type="text/event-stream")
