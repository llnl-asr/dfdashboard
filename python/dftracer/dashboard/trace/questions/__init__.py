"""One descriptor per question.

A question states what the engine must read (`columns`), how the plan is built
and how a frame becomes a payload. Plans are values, not methods, so
`TraceData.ask` can register several of them over one window and pay one scan.

A question that takes arguments carries them as fields, so construction is type
checked: ``Histogram(nbuckets=100)``. A shape is a pure function of the frame
plus the small facade surface in `Context`; it reads nothing else.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Generic, Literal, Optional, Protocol, TypeVar

if TYPE_CHECKING:
    from dftracer.utils import DataFrame, TraceViewer
    from dftracer.utils.columnar import Expr

    from ...data.metadata import TraceMeta


P = TypeVar("P")


@dataclass(frozen=True, slots=True)
class Window:
    """A request window: trace-relative microseconds plus the user's predicate."""

    begin: float
    end: float
    query: Optional[str] = None
    phase: Optional[Literal["events", "counters", "aggregated", "metadata", "any"]] = None


class Context(Protocol):
    """What a shape may ask the facade for, and the facade is the only provider."""

    def info(self) -> "TraceMeta": ...

    def pid_host_map(self) -> dict[str, str]: ...

    def io_mask(self) -> "Expr": ...

    def gap_limits(self) -> tuple[int, float, int]: ...


class Question(ABC, Generic[P]):
    """A plan plus the pure function that turns its frame into a payload."""

    __slots__ = ()

    name: ClassVar[str]
    columns: ClassVar[tuple[str, ...]]

    def plan(self, viewer: "TraceViewer") -> "TraceViewer":
        return viewer.select(list(self.columns))

    @abstractmethod
    def shape(self, frame: "DataFrame", ctx: Context) -> P:
        """Pure: the frame in, the payload out, nothing read, nothing cached."""
