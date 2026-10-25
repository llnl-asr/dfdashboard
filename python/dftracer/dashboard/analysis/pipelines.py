"""Built-in analysis pipelines."""

from __future__ import annotations

import asyncio
import importlib.util
import logging
from collections import defaultdict
from collections.abc import Awaitable
from typing import TYPE_CHECKING, Optional, cast

from pydantic import BaseModel

from .base import Pipeline, Result, RunContext, register_pipeline

if TYPE_CHECKING:
    from ..trace import TraceData

log = logging.getLogger(__name__)


class IOSummaryParams(BaseModel):
    pass


class IOSummaryPipeline(Pipeline):
    id = "io_summary"
    label = "I/O bytes by host"
    description = "Total read/written bytes per node."
    Params = IOSummaryParams

    async def run(self, ctx: RunContext, params: BaseModel) -> Result:
        if ctx.data is None:
            raise ValueError("no trace loaded")
        ctx.progress(0.2, "reading process tree")
        nodes = await asyncio.to_thread(ctx.data.proctree)
        by_host: dict[str, int] = defaultdict(int)
        for n in nodes["nodes"]:
            by_host[n["host"] or "unknown"] += int(n["bytes"])
        ctx.progress(1.0, "done")
        return Result(data={"bytes_by_host": dict(by_host)}, meta={"hosts": len(by_host)})


def _loaded(ctx: RunContext) -> "TraceData":
    """The trace this run reads, or a clear error when nothing is loaded."""
    if ctx.data is None:
        raise ValueError("no trace loaded")
    return ctx.data


class BandwidthScanParams(BaseModel):
    buckets: int = 120


class BandwidthScanPipeline(Pipeline):
    id = "bandwidth_scan"
    label = "I/O bandwidth over time"
    description = "Read/write GB/s per time bucket, streamed bucket by bucket."
    Params = BandwidthScanParams

    async def run(self, ctx: RunContext, params: BaseModel) -> Result:
        assert isinstance(params, BandwidthScanParams)
        import io as _io

        import pyarrow.ipc as ipc

        trace = _loaded(ctx)
        info = await asyncio.to_thread(trace.info)
        span = info.global_max_ts - info.global_min_ts
        n = max(params.buckets, 1)
        data = await asyncio.to_thread(trace.counters_arrow, 0.0, float(span), n, None)
        tbl = ipc.open_stream(_io.BytesIO(data)).read_all()
        read = tbl.column("read_bytes").to_pylist()
        write = tbl.column("write_bytes").to_pylist()
        bucket_s = max((span / n) / 1e6, 1e-9)
        await asyncio.sleep(1.2)  # let the plot session connect before emitting
        for i in range(n):
            ctx.emit({"x": i, "read": read[i] / bucket_s / 1e9, "write": write[i] / bucket_s / 1e9})
            ctx.progress((i + 1) / n, "streaming")
            await asyncio.sleep(0.03)  # pace so the plot visibly fills
        return Result(data={"buckets": n}, meta={"buckets": n})


class CardComputeParams(BaseModel):
    op: str  # op_stats | counters | histogram | size_histogram | access_pattern | proc_bytes
    begin: float = 0.0
    end: float = 0.0  # <=0 means the full trace span
    query: Optional[str] = None
    n: int = 120
    nbuckets: int = 48
    use_dask: bool = False  # offload to the cluster instead of a local thread


class CardComputePipeline(Pipeline):
    id = "card_compute"
    label = "Overview card compute"
    description = "Windowed trace statistics backing a single overview card."
    Params = CardComputeParams
    internal = True

    async def run(self, ctx: RunContext, params: BaseModel) -> Result:
        from ..compute.worker import dispatch_op, worker_compute

        assert isinstance(params, CardComputeParams)
        trace = ctx.data
        if trace is None:
            raise ValueError("no trace loaded")
        ctx.progress(0.1, "resolving window")
        if params.end > 0:
            end = params.end
        else:
            info = await asyncio.to_thread(trace.info)
            end = float(info.global_max_ts - info.global_min_ts)
        begin, q = params.begin, params.query or None

        use_dask = params.use_dask and importlib.util.find_spec("distributed") is not None
        if params.use_dask and not use_dask:
            log.warning("distributed is not installed; %s runs locally", params.op)

        if use_dask:
            ctx.progress(0.4, "dispatching to cluster")
            client = await ctx.get_client()
            fut = client.submit(
                worker_compute,
                params.op,
                begin,
                end,
                q,
                params.n,
                params.nbuckets,
                getattr(trace, "index_dir", ""),
                getattr(trace, "paths", None),
                pure=False,
            )
            data = await cast("Awaitable[object]", fut)
        else:
            ctx.progress(0.4, "querying index")
            data = await asyncio.to_thread(
                dispatch_op, trace, params.op, begin, end, q, params.n, params.nbuckets
            )

        ctx.progress(1.0, "done")
        return Result(data=data, meta={"op": params.op, "begin": begin, "end": end})


def register_builtins() -> None:
    register_pipeline(IOSummaryPipeline())
    register_pipeline(BandwidthScanPipeline())
    register_pipeline(CardComputePipeline())
