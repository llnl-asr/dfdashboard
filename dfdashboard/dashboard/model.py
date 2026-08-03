"""Declarative dashboard spec: a board of typed panels on a grid.

The spec is the single source of truth; the renderer builds it into a Panel
layout and a UI editor or AI command layer mutates the same spec.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class GridPos(BaseModel):
    x: int = 0
    y: int = 0
    w: int = 12  # out of a 12-column row
    h: int = 4  # grid-height units


class PanelSpec(BaseModel):
    id: str
    type: str
    title: str = ""
    grid: GridPos = Field(default_factory=GridPos)
    options: dict[str, Any] = Field(default_factory=dict)


class DashboardSpec(BaseModel):
    id: str = "overview"
    title: str = "Overview"
    panels: list[PanelSpec] = Field(default_factory=list)


class DashboardContext:
    def __init__(self, trace: Any) -> None:
        self.trace = trace
