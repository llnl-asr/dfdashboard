"""Pipeline plugin contract: the unit the task queue dispatches."""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from typing import Any, Callable, ClassVar

from pydantic import BaseModel

PIPELINE_ENTRY_GROUP = "dftracer.dashboard.pipelines"


@dataclass
class RunContext:
    on_progress: Callable[[float, str], None] = lambda frac, msg="": None
    on_partial: Callable[[Any], None] = lambda payload: None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    client: Any = None
    data: Any = None
    client_provider: Any = None  # async () -> Dask client; spawns lazily

    async def get_client(self) -> Any:
        if self.client is None and self.client_provider is not None:
            self.client = await self.client_provider()
        return self.client

    def progress(self, frac: float, msg: str = "") -> None:
        self.on_progress(frac, msg)

    def emit(self, payload: Any) -> None:
        self.on_partial(payload)

    @property
    def cancelled(self) -> bool:
        return self.cancel.is_set()


@dataclass
class Result:
    data: Any = None
    meta: dict[str, Any] = field(default_factory=dict)


class Pipeline(ABC):
    id: ClassVar[str]
    label: ClassVar[str]
    description: ClassVar[str] = ""
    Params: ClassVar[type[BaseModel]]
    API_VERSION: ClassVar[int] = 1
    internal: ClassVar[bool] = False  # hidden from the user-facing pipeline list

    @abstractmethod
    async def run(self, ctx: RunContext, params: BaseModel) -> Result: ...

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "params_schema": self.Params.model_json_schema(),
        }


_REGISTRY: dict[str, Pipeline] = {}


def register_pipeline(pipeline: Pipeline) -> Pipeline:
    _REGISTRY[pipeline.id] = pipeline
    return pipeline


def get_pipeline(pipeline_id: str) -> Pipeline | None:
    return _REGISTRY.get(pipeline_id)


def list_pipelines() -> list[Pipeline]:
    return list(_REGISTRY.values())


def load_plugins() -> list[str]:
    """Discover third-party pipelines via entry points; a broken one is skipped."""
    loaded: list[str] = []
    for ep in entry_points(group=PIPELINE_ENTRY_GROUP):
        try:
            obj = ep.load()
            pipeline = obj() if isinstance(obj, type) else obj
            register_pipeline(pipeline)
            loaded.append(pipeline.id)
        except Exception:
            continue
    return loaded
