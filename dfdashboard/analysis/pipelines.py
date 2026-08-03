"""Built-in analysis pipelines."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
from collections import defaultdict
from typing import Optional

from pydantic import BaseModel

from .base import Pipeline, Result, RunContext, register_pipeline


class IOSummaryParams(BaseModel):
    pass


class IOSummaryPipeline(Pipeline):
    id = "io_summary"
    label = "I/O bytes by host"
    description = "Total read/written bytes per node, aggregated on the cluster."
    Params = IOSummaryParams

    async def run(self, ctx: RunContext, params: BaseModel) -> Result:
        ctx.progress(0.1, "reading process tree")
        nodes = await asyncio.to_thread(ctx.data.proctree)
        by_host: dict[str, list[int]] = defaultdict(list)
        for n in nodes["nodes"]:
            by_host[n["host"] or "unknown"].append(n["bytes"])

        ctx.progress(0.4, "starting cluster")
        client = await ctx.get_client()

        ctx.progress(0.6, "aggregating")
        futures = {h: client.submit(lambda v: int(sum(v)), vals) for h, vals in by_host.items()}
        result = {h: await f for h, f in futures.items()}

        ctx.progress(1.0, "done")
        return Result(data={"bytes_by_host": result}, meta={"hosts": len(result)})


class DFAnalyzerParams(BaseModel):
    trace_path: Optional[str] = None  # defaults to the loaded trace's directory
    time_granularity: float = 1.0


class DFAnalyzerPipeline(Pipeline):
    id = "dfanalyzer"
    label = "DFAnalyzer deep analysis"
    description = "Run dftracer-analyzer's fact engine; returns the fact envelope."
    Params = DFAnalyzerParams

    async def run(self, ctx: RunContext, params: BaseModel) -> Result:
        assert isinstance(params, DFAnalyzerParams)
        trace_path = params.trace_path or (ctx.data.trace_dir if ctx.data else "")
        if not trace_path:
            raise ValueError("no trace_path and no loaded trace")

        out_dir = tempfile.mkdtemp(prefix="dfa-")
        ctx.progress(0.1, "starting analyzer")
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "dfdashboard.analysis._dfa_worker",
            trace_path,
            str(params.time_granularity),
            out_dir,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        ctx.progress(0.4, "analyzing trace")
        _stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"dfanalyzer failed: {stderr.decode()[-800:]}")
        with open(os.path.join(out_dir, "result.json")) as f:
            res = json.load(f)
        ctx.progress(1.0, "done")
        mv = os.path.join(out_dir, "main_view.parquet")
        res["main_view_path"] = mv if os.path.exists(mv) else ""
        return Result(
            data=res,
            meta={"facts": len(res.get("facts") or []), "rows": len(res.get("columns") or [])},
        )


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

        info = await asyncio.to_thread(ctx.data.info)
        span = info.global_max_ts - info.global_min_ts
        n = max(params.buckets, 1)
        data = await asyncio.to_thread(ctx.data.counters_arrow, 0.0, float(span), n, None)
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
    op: str  # op_stats | counters | histogram | size_histogram | access_pattern
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

        if params.use_dask:
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
            data = await fut
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
    if importlib.util.find_spec("dftracer.analyzer") is not None:
        register_pipeline(DFAnalyzerPipeline())
