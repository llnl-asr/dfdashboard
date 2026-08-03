"""Panel-type registry: one factory per panel type, shared across renderers."""

from __future__ import annotations

from typing import Any, Callable

import panel as pn

from .model import PanelSpec

PanelFactory = Callable[[PanelSpec, Any], "pn.viewable.Viewable"]
_REGISTRY: dict[str, PanelFactory] = {}


def register(name: str) -> Callable[[PanelFactory], PanelFactory]:
    def deco(fn: PanelFactory) -> PanelFactory:
        _REGISTRY[name] = fn
        return fn

    return deco


def build_panel(spec: PanelSpec, ctx: Any) -> "pn.viewable.Viewable":
    fn = _REGISTRY.get(spec.type)
    if fn is None:
        return pn.pane.HTML(f"unknown panel type: {spec.type}")
    return fn(spec, ctx)


def panel_types() -> list[str]:
    return sorted(_REGISTRY)
