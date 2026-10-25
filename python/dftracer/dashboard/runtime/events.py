"""Async pub/sub bus for task state and partial results."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import AsyncIterator


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)

    def emit(self, topic: str, payload: object) -> None:
        for q in tuple(self._subs.get(topic, ())):
            q.put_nowait((topic, payload))

    def listen(self, topic: str) -> asyncio.Queue:
        """Subscribe synchronously (no `subscribe` first-await race); `unlisten` when done."""
        q: asyncio.Queue = asyncio.Queue()
        self._subs[topic].add(q)
        return q

    def unlisten(self, topic: str, q: asyncio.Queue) -> None:
        self._subs[topic].discard(q)

    async def subscribe(self, topic: str) -> AsyncIterator[tuple[str, object]]:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[topic].add(q)
        try:
            while True:
                yield await q.get()
        finally:
            self._subs[topic].discard(q)
