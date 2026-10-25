"""Scheduling for Bokeh document callbacks.

Bokeh 3.10 initializes a new document in a worker thread, and a worker thread
has no running event loop, so ``asyncio.ensure_future()`` raises there. The
lifespan binds the server loop once, and callbacks schedule onto it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from concurrent.futures import Future
from typing import Any

from fastapi import FastAPI

LOOP_ATTR = "loop"


def bind(app: FastAPI) -> None:
    """Store the server loop on the app; call this from the lifespan."""
    setattr(app.state, LOOP_ATTR, asyncio.get_running_loop())


def spawn(app: FastAPI, coro: Coroutine[Any, Any, None]) -> Future[None] | asyncio.Future[None]:
    """Schedule ``coro`` on the server loop, from any thread.

    Returns a future whose ``cancel()`` stops the coroutine.
    """
    loop = getattr(app.state, LOOP_ATTR, None)
    if loop is not None and loop.is_running():
        return asyncio.run_coroutine_threadsafe(coro, loop)
    return asyncio.ensure_future(coro)
