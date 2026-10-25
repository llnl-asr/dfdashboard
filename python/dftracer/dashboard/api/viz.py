"""Viz data API: trace info plus the timeline query endpoints.

Blocking (GIL-releasing) reads are offloaded with asyncio.to_thread so the event
loop stays responsive.
"""

from __future__ import annotations

import asyncio
from typing import Callable, Optional, TypeVar

from dftracer.utils import DFTUtilsDuqlError, DFTUtilsParseError, DFTUtilsValueError
from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import StreamingResponse

from ..core.errors import INVALID_QUERY, ApiError
from ..data.run_types import UntimedPayload
from ..trace import TraceData
from ..trace.counters import NodeCountersPayload, SeriesPayload, SplitPayload
from ..trace.questions.types import BreaksPayload, CalltreePayload, HistogramPayload, StatsPayload
from .cache import LRUCache
from .deps import get_n_files, get_trace
from .schemas import EventsPayload, EventWindow, Info, Layers, ProcTree, TimeRange

T = TypeVar("T")

ARROW_MIME = "application/vnd.apache.arrow.stream"

router = APIRouter(prefix="/api", tags=["viz"])
_responses = LRUCache(maxsize=64)


async def _run(fn: Callable[..., T], *args: object) -> T:
    try:
        return await asyncio.to_thread(fn, *args)
    except (DFTUtilsDuqlError, DFTUtilsValueError, DFTUtilsParseError, ValueError) as e:
        # The engine raises a bare ValueError for some filters ("Unexpected
        # character"), so a bad filter must be a 400 and not a 500.
        raise ApiError(400, INVALID_QUERY, f"invalid query: {e}") from e


@router.get("/info", response_model=Info)
async def info(trace: TraceData = Depends(get_trace), n_files: int = Depends(get_n_files)) -> Info:
    i = await asyncio.to_thread(trace.info)
    return Info(
        file_count=n_files,
        num_events=i.num_events,
        global_min_timestamp_us=i.global_min_ts,
        global_max_timestamp_us=i.global_max_ts,
        total_bytes=i.total_bytes,
        total_io_busy=i.total_io_busy,
        io_share=i.io_share,
        time_range=TimeRange(min_timestamp_us=i.global_min_ts, max_timestamp_us=i.global_max_ts),
    )


@router.get("/viz/events.arrow")
async def events_arrow(
    begin: float,
    end: float,
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> Response:
    data = await _run(trace.events_arrow, begin, end, query)
    return Response(content=data, media_type=ARROW_MIME)


@router.get("/viz/timeline.arrow")
async def timeline_arrow(
    begin: float,
    end: float,
    width: int = Query(1200, ge=1),
    summary: int = Query(1, ge=1),
    lookback: float = Query(0, ge=0),
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> StreamingResponse:
    gen = trace.timeline_stream(begin, end, width, summary, lookback, query)
    return StreamingResponse(gen, media_type=ARROW_MIME)


@router.get("/viz/events")
async def events(
    begin: float,
    end: float,
    summary: int = 1,
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> EventsPayload:
    ev = await _run(trace.events, begin, end, query)
    return EventsPayload(events=ev, metadata=EventWindow(begin=begin, end=end, count=len(ev)))


@router.get("/viz/counters.arrow")
async def counters_arrow(
    begin: float,
    end: float,
    buckets: int = Query(400, ge=1),
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> Response:
    data = await _run(trace.counters_arrow, begin, end, buckets, query)
    return Response(content=data, media_type=ARROW_MIME)


@router.get("/viz/counters/series")
async def counter_series(
    begin: float,
    end: float,
    width: int = Query(800, ge=1),
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> SeriesPayload:
    return await _run(trace.counter_series, begin, end, width, query)


@router.get("/viz/counters/nodes")
async def node_counters(
    begin: float,
    end: float,
    width: int = Query(700, ge=1),
    trace: TraceData = Depends(get_trace),
) -> NodeCountersPayload:
    return await _run(trace.node_counters, begin, end, width)


@router.get("/viz/counters/split")
async def counter_split(
    begin: float,
    end: float,
    series: str,
    dim: str = Query("pid", pattern="^(pid|node)$"),
    width: int = Query(700, ge=1),
    top: int = Query(32, ge=1, le=256),
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> SplitPayload:
    return await _run(trace.counter_split, begin, end, series, dim, width, top, query)


@router.get("/viz/stats", response_model=StatsPayload)
async def stats(
    begin: float,
    end: float,
    query: Optional[str] = None,
    group: str = "name",
    trace: TraceData = Depends(get_trace),
) -> StatsPayload:
    return await _run(trace.stats, begin, end, query, group)


@router.get("/viz/calltree")
async def calltree(
    begin: float,
    end: float,
    query: Optional[str] = None,
    group: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> CalltreePayload:
    key = (trace.cache_key, "calltree", begin, end, query, group)
    return await _responses.get_or_set(
        key, lambda: _run(trace.calltree, begin, end, query, group == "pid")
    )


@router.get("/viz/proctree", response_model=ProcTree)
async def proctree(trace: TraceData = Depends(get_trace)) -> dict[str, object]:
    return await asyncio.to_thread(trace.proctree)


@router.get("/viz/breaks", response_model=BreaksPayload)
async def breaks(trace: TraceData = Depends(get_trace)) -> BreaksPayload:
    return await asyncio.to_thread(trace.breaks)


@router.get("/viz/histogram")
async def histogram(
    begin: float,
    end: float,
    query: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> HistogramPayload:
    return await _run(trace.histogram, begin, end, query)


@router.get("/viz/layers", response_model=Layers)
async def layers(trace: TraceData = Depends(get_trace)) -> dict[str, object]:
    return await asyncio.to_thread(trace.layers)


@router.get("/viz/columns")
async def columns(trace: TraceData = Depends(get_trace)) -> dict[str, object]:
    names = await asyncio.to_thread(trace.field_names)
    return {"columns": names, "ready": True}


@router.get("/viz/untimed")
async def untimed(
    limit: int = Query(200, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    duql: Optional[str] = None,
    trace: TraceData = Depends(get_trace),
) -> UntimedPayload:
    return await _run(trace.untimed, limit, offset, duql)


@router.get("/rowset")
async def rowset(
    name: str = Query(pattern="^(files|hosts)$"),
    keys: str = "",
    trace: TraceData = Depends(get_trace),
) -> dict[str, dict[str, str]]:
    """The hash -> name map of one declared row set, optionally only ``keys``."""
    table = await asyncio.to_thread(lambda: trace.files() if name == "files" else trace.hosts())
    if keys:
        wanted = {k for k in keys.split(",") if k}
        table = {k: v for k, v in table.items() if k in wanted}
    return {"names": table}
