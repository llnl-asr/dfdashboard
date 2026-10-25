"""Provenance graph API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..data.prov_types import ProvGraph
from ..runtime.pool import pools
from ..trace import TraceData
from .cache import LRUCache
from .deps import get_trace

router = APIRouter(prefix="/api", tags=["prov"])
_cache = LRUCache(maxsize=8)


@router.get("/prov/graph")
async def prov_graph(
    io: int = Query(1, ge=0, le=1),
    all_files: int = Query(0, ge=0, le=1),
    mounts: str = "",
    trace: TraceData = Depends(get_trace),
) -> ProvGraph:
    extra = tuple(m for m in (p.strip() for p in mounts.split(",")) if m)
    key = (trace.cache_key, "prov", io, all_files, extra)

    async def build() -> ProvGraph:
        return await pools().run_compute(
            trace.provenance,
            include_io=bool(io),
            include_all_files=bool(all_files),
            mounts=extra,
        )

    return await _cache.get_or_set(key, build)
