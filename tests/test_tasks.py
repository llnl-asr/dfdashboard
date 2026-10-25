import asyncio

import pytest
from dftracer.dashboard.analysis.base import Pipeline, Result, RunContext
from dftracer.dashboard.runtime import EventBus, InProcessTaskBackend, TaskSpec, TaskState
from pydantic import BaseModel


class EchoParams(BaseModel):
    value: int = 0
    delay: float = 0.0


class EchoPipeline(Pipeline):
    id = "echo"
    label = "Echo"
    Params = EchoParams

    async def run(self, ctx: RunContext, params: EchoParams) -> Result:
        ctx.progress(0.5, "half")
        if params.delay:
            await asyncio.sleep(params.delay)
        return Result(data=params.value * 2)


def make_backend(pipelines):
    bus = EventBus()
    reg = {p.id: p for p in pipelines}
    return bus, InProcessTaskBackend(lambda pid: reg.get(pid), bus)


async def wait_state(backend, task_id, state, timeout=3.0):
    async with asyncio.timeout(timeout):
        while True:
            rec = backend.get(task_id)
            if rec and rec.state == state:
                return rec
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_run_to_completion():
    _, backend = make_backend([EchoPipeline()])
    await backend.start()
    tid = await backend.submit(TaskSpec(pipeline_id="echo", params={"value": 21}))
    rec = await wait_state(backend, tid, TaskState.DONE)
    assert rec.result.data == 42
    assert rec.progress == 1.0
    await backend.stop()


@pytest.mark.asyncio
async def test_dedup_active():
    _, backend = make_backend([EchoPipeline()])
    await backend.start()
    t1 = await backend.submit(TaskSpec(pipeline_id="echo", params={"value": 1, "delay": 0.2}))
    t2 = await backend.submit(TaskSpec(pipeline_id="echo", params={"value": 1, "delay": 0.2}))
    assert t1 == t2
    await wait_state(backend, t1, TaskState.DONE)
    await backend.stop()


@pytest.mark.asyncio
async def test_unknown_pipeline_fails():
    _, backend = make_backend([])
    await backend.start()
    tid = await backend.submit(TaskSpec(pipeline_id="nope"))
    rec = await wait_state(backend, tid, TaskState.FAILED)
    assert "unknown pipeline" in rec.error
    await backend.stop()


@pytest.mark.asyncio
async def test_cancel_running():
    _, backend = make_backend([EchoPipeline()])
    await backend.start()
    tid = await backend.submit(TaskSpec(pipeline_id="echo", params={"value": 1, "delay": 5.0}))
    await wait_state(backend, tid, TaskState.RUNNING)
    assert await backend.cancel(tid)
    rec = await wait_state(backend, tid, TaskState.CANCELLED)
    assert rec.state == TaskState.CANCELLED
    await backend.stop()


@pytest.mark.asyncio
async def test_events_emitted():
    bus, backend = make_backend([EchoPipeline()])
    await backend.start()
    seen: list[str] = []

    async def collect():
        async for _topic, payload in bus.subscribe("task"):
            seen.append(payload["state"])
            if payload["state"] == "done":
                return

    task = asyncio.create_task(collect())
    await backend.submit(TaskSpec(pipeline_id="echo", params={"value": 2}))
    async with asyncio.timeout(3.0):
        await task
    assert "running" in seen and "done" in seen
    await backend.stop()
