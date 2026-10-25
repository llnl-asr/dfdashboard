"""In-process LRU for repeat-heavy endpoint responses."""

from __future__ import annotations

from collections import OrderedDict
from typing import Awaitable, Callable, Hashable, cast


class LRUCache:
    def __init__(self, maxsize: int = 64) -> None:
        self._store: OrderedDict[Hashable, object] = OrderedDict()
        self._max = maxsize

    async def get_or_set[T](self, key: Hashable, factory: Callable[[], Awaitable[T]]) -> T:
        hit = self._store.get(key)
        if hit is not None:
            self._store.move_to_end(key)
            return cast("T", hit)
        value = await factory()
        self._store[key] = value
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)
        return value

    def clear(self) -> None:
        self._store.clear()
