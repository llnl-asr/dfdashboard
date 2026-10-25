"""Dask cluster access, spawned lazily on first use.

No scheduler is created at startup; the first pipeline that asks for a client
spawns a LocalCluster (or connects to `scheduler_address`), and it is reused.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import TYPE_CHECKING, Optional, cast

from typing_extensions import TypedDict

if TYPE_CHECKING:
    from distributed import Client, LocalCluster


class ClusterStatus(TypedDict):
    running: bool
    workers: int
    address: Optional[str]


class ClusterManager:
    def __init__(self, scheduler_address: Optional[str] = None) -> None:
        self._addr = scheduler_address
        self._client: Optional[Client] = None
        self._cluster: Optional[LocalCluster] = None
        self._lock = asyncio.Lock()

    async def client(self) -> Client:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is not None:
                return self._client
            from distributed import Client, LocalCluster

            if self._addr:
                self._client = await Client(self._addr, asynchronous=True)
            else:
                # Threaded workers: no process spawn (which re-imports __main__
                # and is fragile under uvicorn); fine for I/O-bound analysis.
                self._cluster = await LocalCluster(
                    asynchronous=True, processes=False, dashboard_address=None
                )
                self._client = await Client(self._cluster, asynchronous=True)
            return self._client

    def status(self) -> ClusterStatus:
        if self._client is None:
            return ClusterStatus(running=False, workers=0, address=None)
        info = self._client.scheduler_info()
        return ClusterStatus(
            running=True,
            workers=len(info.get("workers", {})),
            # the configured address is what the user asked for; without one
            # the client talks to the local cluster we started.
            address=self._addr or "local",
        )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
        if self._cluster is not None:
            await cast("Awaitable[None]", self._cluster.close())
            self._cluster = None
