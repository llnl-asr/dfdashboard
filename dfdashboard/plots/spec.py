"""Declarative, validatable plot spec; builders map it onto hvPlot or Vega."""

from __future__ import annotations

from enum import Enum
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field


class Mark(str, Enum):
    LINE = "line"
    BAR = "bar"
    SCATTER = "scatter"
    AREA = "area"
    HEATMAP = "heatmap"
    TABLE = "table"
    GRAPH = "graph"


Agg = Literal["sum", "mean", "count", "min", "max"]


class PlotSpec(BaseModel):
    source: str
    mark: Mark
    x: Optional[str] = None
    y: Optional[Union[str, list[str]]] = None
    color: Optional[str] = None
    agg: Optional[Agg] = None
    title: Optional[str] = None
    limit: int = Field(default=0, ge=0)
