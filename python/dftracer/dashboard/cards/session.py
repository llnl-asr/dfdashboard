"""Per-Bokeh-session plumbing: request args, the app's trace, and task submission."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from ..analysis.base import RunContext, get_pipeline
from ..analysis.pipelines import CardComputeParams
from ..runtime.tasks import TERMINAL, Lane, TaskSpec, TaskState


def qargs(doc: Any) -> dict[str, str]:
    """The embed's query arguments, read back per session."""
    try:
        args = doc.session_context.request.arguments or {}
    except Exception:
        return {}
    out: dict[str, str] = {}
    for k, v in args.items():
        if v:
            val = v[0]
            out[k] = val.decode() if isinstance(val, (bytes, bytearray)) else str(val)
    return out


def theme_of(doc: Any) -> str:
    return "light" if qargs(doc).get("theme") == "light" else "dark"


def has_trace(app: Any) -> bool:
    """Whether any trace is loaded, asking the watcher when one is running.

    In watch mode the tree starts empty, so `app.state.trace` stays None while
    the current trace comes from the registry.
    """
    registry = getattr(app.state, "registry", None)
    if registry is not None:
        return registry.trace() is not None
    return getattr(app.state, "trace", None) is not None


async def run_task(app: Any, spec: TaskSpec) -> Any:
    """Run a pipeline through the task backend and return its Result.

    Cancels the backend task if this coroutine is cancelled (session torn down
    by a filter change). Falls back to running the pipeline inline when no
    backend exists.
    """
    backend = getattr(app.state, "backend", None)
    events = getattr(app.state, "events", None)
    if backend is None or events is None:
        pipeline = get_pipeline(spec.pipeline_id)
        if pipeline is None:
            return None
        cluster = getattr(app.state, "cluster", None)
        ctx = RunContext(
            data=getattr(app.state, "trace", None),
            client_provider=(cluster.client if cluster else None),
        )
        return await pipeline.run(ctx, pipeline.Params(**spec.params))

    q = events.listen("task")
    task_id: Optional[str] = None
    try:
        task_id = await backend.submit(spec)
        while True:
            rec = backend.get(task_id)
            if rec is not None and rec.state in TERMINAL:
                break
            await q.get()
        if rec is None or rec.state != TaskState.DONE:
            raise RuntimeError((rec and rec.error) or "task failed")
        return rec.result
    except asyncio.CancelledError:
        if task_id is not None:
            await backend.cancel(task_id)
        raise
    finally:
        events.unlisten("task", q)


async def compute(app: Any, doc: Any, op: str, n: int = 120, nbuckets: int = 48) -> Any:
    """Run this card's window through the `card_compute` task and return its Result."""
    if not has_trace(app):
        return None
    a = qargs(doc)
    try:
        begin = float(a.get("begin") or 0.0)
        end = float(a.get("end") or 0.0)
    except ValueError:
        begin, end = 0.0, 0.0
    query = (a.get("query") or "").strip() or None
    params = CardComputeParams(op=op, begin=begin, end=end, query=query, n=n, nbuckets=nbuckets)
    spec = TaskSpec(
        pipeline_id="card_compute",
        params=params.model_dump(),
        lane=Lane.INTERACTIVE,
    )
    return await run_task(app, spec)
