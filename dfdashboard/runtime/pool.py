"""The process's thread pools, in one place.

Two pools and no more: blocking work (filesystem, network file systems, engine
calls that release the GIL) and CPU-bound Python. Anything that needs threads
asks here, so a subsystem never invents its own executor.

`Pools.bind(loop)` makes `asyncio.to_thread` run on the blocking pool too, which
is what every existing `await asyncio.to_thread(...)` already uses.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

DEFAULT_IO_WORKERS = 32


def _cpu_count() -> int:
    affinity = getattr(os, "sched_getaffinity", None)
    if affinity is not None:
        try:
            return max(1, len(affinity(0)))
        except OSError:
            pass
    return max(1, os.cpu_count() or 1)


class _PersistentPool(ThreadPoolExecutor):
    """A pool that outlives the event loop that used it.

    `loop.close()` shuts down the loop's default executor, and this pool serves
    several loops over a process lifetime (a test app, a restarted loop), so the
    close that asyncio performs must not land. `stop()` is the real one.
    """

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        return None

    def stop(self) -> None:
        ThreadPoolExecutor.shutdown(self, wait=False)


class Pools:
    """Blocking pool plus CPU pool, created once per process."""

    def __init__(
        self, io_workers: Optional[int] = None, compute_workers: Optional[int] = None
    ) -> None:
        self.io_workers = max(1, io_workers or DEFAULT_IO_WORKERS)
        self.compute_workers = max(1, compute_workers or _cpu_count())
        self.io = _PersistentPool(max_workers=self.io_workers, thread_name_prefix="dfd-io")
        self.compute = ThreadPoolExecutor(
            max_workers=self.compute_workers, thread_name_prefix="dfd-cpu"
        )
        self._bound = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """Route `asyncio.to_thread` (and any default executor) to the io pool."""
        loop.set_default_executor(self.io)
        self._bound = True

    def submit_compute(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Future:
        return self.compute.submit(functools.partial(fn, *args, **kwargs))

    async def run_compute(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.compute, functools.partial(fn, *args, **kwargs))

    def describe(self) -> dict[str, int]:
        return {"io_workers": self.io_workers, "compute_workers": self.compute_workers}

    def close(self) -> None:
        self.io.stop()
        self.compute.shutdown(wait=False)


_pools: Optional[Pools] = None
_refs = 0


def configure(io_workers: Optional[int] = None, compute_workers: Optional[int] = None) -> Pools:
    """The process pools, created on first use. Sizes are fixed at creation."""
    global _pools
    if _pools is None:
        _pools = Pools(io_workers, compute_workers)
        log.info("thread pools: io=%d compute=%d", _pools.io_workers, _pools.compute_workers)
    return _pools


def pools() -> Pools:
    return configure()


def acquire(io_workers: Optional[int] = None, compute_workers: Optional[int] = None) -> Pools:
    """Take a reference, for a server lifespan or a test app."""
    global _refs
    got = configure(io_workers, compute_workers)
    _refs += 1
    return got


def release() -> None:
    """Drop a reference; the pools close with the last one."""
    global _pools, _refs
    _refs = max(0, _refs - 1)
    if _refs == 0 and _pools is not None:
        _pools.close()
        _pools = None


def close() -> None:
    global _refs
    _refs = 0
    release()
