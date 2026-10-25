"""Task-history store; a persistent backend plugs in behind the same interface."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from .tasks import TaskDict


class Store(Protocol):
    def put(self, task_id: str, record: TaskDict) -> None: ...
    def get(self, task_id: str) -> TaskDict | None: ...
    def records(self) -> list[TaskDict]: ...


class InMemoryStore:
    def __init__(self) -> None:
        self._records: dict[str, TaskDict] = {}

    def put(self, task_id: str, record: TaskDict) -> None:
        self._records[task_id] = record

    def get(self, task_id: str) -> TaskDict | None:
        return self._records.get(task_id)

    def records(self) -> list[TaskDict]:
        return list(self._records.values())
