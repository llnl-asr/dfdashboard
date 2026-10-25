"""Pipeline plugin contract: the unit the task queue dispatches."""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Awaitable
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from typing import TYPE_CHECKING, Callable, ClassVar, Optional, Protocol, cast

if TYPE_CHECKING:
    from ..trace import TraceData

from pydantic import BaseModel

PIPELINE_ENTRY_GROUP = "dftracer.dashboard.pipelines"


class SubmitClient(Protocol):
    """The bit of a Dask client a pipeline uses, so `distributed` stays optional."""

    def submit(self, fn: Callable[..., object], *args: object, **kwargs: object) -> object: ...


@dataclass
class RunContext:
    on_progress: Callable[[float, str], None] = lambda frac, msg="": None
    on_partial: Callable[[object], None] = lambda payload: None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    client: Optional[object] = None
    data: Optional["TraceData"] = None
    # async () -> the cluster client; spawns it lazily on first use
    client_provider: Optional[Callable[[], Awaitable[object]]] = None

    async def get_client(self) -> SubmitClient:
        if self.client is None and self.client_provider is not None:
            self.client = await self.client_provider()
        return cast("SubmitClient", self.client)

    def progress(self, frac: float, msg: str = "") -> None:
        self.on_progress(frac, msg)

    def emit(self, payload: object) -> None:
        self.on_partial(payload)

    @property
    def cancelled(self) -> bool:
        return self.cancel.is_set()


@dataclass
class Result:
    """A pipeline's output: the payload a card or a table renders, plus notes."""

    data: object = None
    meta: dict[str, object] = field(default_factory=dict)


class Pipeline(ABC):
    id: ClassVar[str]
    label: ClassVar[str]
    description: ClassVar[str] = ""
    Params: ClassVar[type[BaseModel]]
    API_VERSION: ClassVar[int] = 1
    internal: ClassVar[bool] = False  # hidden from the user-facing pipeline list

    @abstractmethod
    async def run(self, ctx: RunContext, params: BaseModel) -> Result: ...

    def describe(self) -> dict[str, object]:
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
