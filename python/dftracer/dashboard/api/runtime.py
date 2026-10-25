"""Runtime status: Dask cluster state + task-queue counts for the status bar."""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends

from ..runtime import InProcessTaskBackend
from .deps import get_backend, get_cluster

if TYPE_CHECKING:
    from ..compute.cluster import ClusterManager

router = APIRouter(prefix="/api", tags=["runtime"])


@router.get("/runtime")
async def runtime(
    backend: InProcessTaskBackend = Depends(get_backend),
    cluster: Optional[ClusterManager] = Depends(get_cluster),
) -> dict[str, object]:
    counts = Counter(r.state.value for r in backend.records())
    cluster_status = cluster.status() if cluster is not None else {"running": False, "workers": 0}
    return {
        "cluster": cluster_status,
        "tasks": {
            "queued": counts.get("queued", 0),
            "running": counts.get("running", 0),
            "done": counts.get("done", 0),
            "failed": counts.get("failed", 0),
        },
    }
