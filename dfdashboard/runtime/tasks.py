"""Task queue: admission, priority lanes, dedup, lifecycle, progress streaming.

The executor (Dask) owns the task graph; the Pipeline is resolved through an
injected callable so this stays decoupled from the registry.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from enum import Enum, IntEnum
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field

from ..analysis.base import Pipeline, Result, RunContext
from .events import EventBus


# Lower value dispatches first (one queue + dispatcher per lane).
class Lane(IntEnum):
    INTERACTIVE = 0
    NORMAL = 1
    BATCH = 2


class TaskState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


TERMINAL = {TaskState.DONE, TaskState.FAILED, TaskState.CANCELLED, TaskState.INTERRUPTED}

DEFAULT_LANE_LIMITS = {Lane.INTERACTIVE: 8, Lane.NORMAL: 4, Lane.BATCH: 2}


class TaskSpec(BaseModel):
    pipeline_id: str
    params: dict[str, Any] = Field(default_factory=dict)
    lane: Lane = Lane.NORMAL
    dedup_key: Optional[str] = None
    submitted_by: Optional[str] = None
    cache: bool = False  # reuse a completed result for an identical spec

    def key(self) -> str:
        if self.dedup_key:
            return self.dedup_key
        payload = json.dumps({"p": self.pipeline_id, "a": self.params}, sort_keys=True, default=str)
        return hashlib.sha1(payload.encode()).hexdigest()


@dataclass
class TaskRecord:
    task_id: str
    spec: TaskSpec
    state: TaskState = TaskState.QUEUED
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: Optional[str] = None
    t_submitted: float = field(default_factory=time.time)
    t_started: Optional[float] = None
    t_done: Optional[float] = None
    _cancel: Optional[asyncio.Event] = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("_cancel", None)
        d.pop("result", None)
        d["spec"] = self.spec.model_dump()
        d["state"] = self.state.value
        return d


class InProcessTaskBackend:
    def __init__(
        self,
        resolve_pipeline: Callable[[str], Optional[Pipeline]],
        events: EventBus,
        lane_limits: Optional[dict[Lane, int]] = None,
        data: Any = None,
        client_provider: Any = None,
        result_cache_size: int = 64,
        max_records: int = 512,
    ) -> None:
        self._resolve = resolve_pipeline
        self._events = events
        self._data = data
        self._client_provider = client_provider
        self._records: dict[str, TaskRecord] = {}
        self._active_by_key: dict[str, str] = {}
        # LRU of completed results for cache=True specs only, so this never holds
        # the large per-window results (bounded by count -> no unbounded growth).
        self._result_cache: OrderedDict[str, Any] = OrderedDict()
        self._result_cache_size = result_cache_size
        self._max_records = max_records
        limits = lane_limits or DEFAULT_LANE_LIMITS
        self._queues = {lane: asyncio.Queue() for lane in limits}
        self._sems = {lane: asyncio.Semaphore(n) for lane, n in limits.items()}
        self._running: dict[str, asyncio.Task] = {}
        self._dispatchers: list[asyncio.Task] = []
        self._closing = False

    async def start(self) -> None:
        if not self._dispatchers:
            self._dispatchers = [asyncio.create_task(self._dispatch(lane)) for lane in self._queues]

    async def stop(self) -> None:
        self._closing = True
        for t in self._dispatchers:
            t.cancel()
        for t in list(self._running.values()):
            t.cancel()
        self._dispatchers.clear()

    async def submit(self, spec: TaskSpec) -> str:
        key = spec.key()
        existing = self._active_by_key.get(key)
        if existing:
            return existing
        if spec.cache and key in self._result_cache:
            self._result_cache.move_to_end(key)
            task_id = uuid.uuid4().hex
            now = time.time()
            rec = TaskRecord(
                task_id=task_id,
                spec=spec,
                state=TaskState.DONE,
                progress=1.0,
                result=self._result_cache[key],
                t_started=now,
                t_done=now,
            )
            self._records[task_id] = rec
            self._emit(rec)
            self._evict_records()
            return task_id
        task_id = uuid.uuid4().hex
        rec = TaskRecord(task_id=task_id, spec=spec)
        self._records[task_id] = rec
        self._active_by_key[key] = task_id
        self._emit(rec)
        self._evict_records()
        await self._queues[spec.lane].put(task_id)
        return task_id

    def _evict_records(self) -> None:
        if len(self._records) <= self._max_records:
            return
        for tid in list(self._records):
            if len(self._records) <= self._max_records:
                break
            if self._records[tid].state in TERMINAL:
                del self._records[tid]

    def get(self, task_id: str) -> Optional[TaskRecord]:
        return self._records.get(task_id)

    def records(self) -> list[TaskRecord]:
        return list(self._records.values())

    async def cancel(self, task_id: str) -> bool:
        rec = self._records.get(task_id)
        if rec is None or rec.state in TERMINAL:
            return False
        if rec.state == TaskState.QUEUED:
            self._finish(rec, TaskState.CANCELLED)
            return True
        if rec._cancel is not None:
            rec._cancel.set()
        t = self._running.get(task_id)
        if t is not None:
            t.cancel()
        return True

    async def _dispatch(self, lane: Lane) -> None:
        queue, sem = self._queues[lane], self._sems[lane]
        while not self._closing:
            task_id = await queue.get()
            rec = self._records.get(task_id)
            if rec is None or rec.state == TaskState.CANCELLED:
                queue.task_done()
                continue
            await sem.acquire()
            if rec.state == TaskState.CANCELLED:
                sem.release()
                queue.task_done()
                continue
            self._running[task_id] = asyncio.create_task(self._run(rec, sem))
            queue.task_done()

    async def _run(self, rec: TaskRecord, sem: asyncio.Semaphore) -> None:
        rec.state = TaskState.RUNNING
        rec.t_started = time.time()
        rec._cancel = asyncio.Event()
        self._emit(rec)
        try:
            pipeline = self._resolve(rec.spec.pipeline_id)
            if pipeline is None:
                raise LookupError(f"unknown pipeline: {rec.spec.pipeline_id}")
            params = pipeline.Params(**rec.spec.params)

            def on_progress(frac: float, msg: str = "") -> None:
                rec.progress = frac
                rec.message = msg
                self._emit(rec)

            ctx = RunContext(
                on_progress=on_progress,
                on_partial=lambda p: self._events.emit(f"task.{rec.task_id}.partial", p),
                cancel=rec._cancel,
                data=self._data,
                client_provider=self._client_provider,
            )
            result = await pipeline.run(ctx, params)
            rec.result = result if isinstance(result, Result) else Result(data=result)
            rec.progress = 1.0
            self._finish(rec, TaskState.DONE, sem)
        except asyncio.CancelledError:
            self._finish(rec, TaskState.CANCELLED, sem)
        except Exception as exc:
            rec.error = repr(exc)
            self._finish(rec, TaskState.FAILED, sem)

    def _finish(
        self, rec: TaskRecord, state: TaskState, sem: Optional[asyncio.Semaphore] = None
    ) -> None:
        rec.state = state
        rec.t_done = time.time()
        if sem is not None:
            sem.release()
        self._running.pop(rec.task_id, None)
        self._active_by_key.pop(rec.spec.key(), None)
        if state == TaskState.DONE and rec.spec.cache and rec.result is not None:
            self._result_cache[rec.spec.key()] = rec.result
            self._result_cache.move_to_end(rec.spec.key())
            while len(self._result_cache) > self._result_cache_size:
                self._result_cache.popitem(last=False)
        self._emit(rec)

    def _emit(self, rec: TaskRecord) -> None:
        self._events.emit("task", rec.to_dict())
