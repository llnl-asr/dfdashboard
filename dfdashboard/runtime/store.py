"""Task-history store; a persistent backend plugs in behind the same interface."""

from __future__ import annotations

from typing import Any, Protocol


class Store(Protocol):
    def put(self, task_id: str, record: dict[str, Any]) -> None: ...
    def get(self, task_id: str) -> dict[str, Any] | None: ...
    def records(self) -> list[dict[str, Any]]: ...


class InMemoryStore:
    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}

    def put(self, task_id: str, record: dict[str, Any]) -> None:
        self._records[task_id] = record

    def get(self, task_id: str) -> dict[str, Any] | None:
        return self._records.get(task_id)

    def records(self) -> list[dict[str, Any]]:
        return list(self._records.values())
