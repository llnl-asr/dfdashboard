import pytest

pytest.importorskip("panel")

from dfdashboard.dashboard import (  # noqa: E402
    DashboardSpec,
    GridPos,
    PanelSpec,
    default_overview,
    panel_types,
)


def test_registry_has_builtin_types():
    assert {"stat", "timeline", "bandwidth"} <= set(panel_types())


def test_default_overview_roundtrips():
    spec = default_overview()
    assert spec.title == "Overview"
    assert {"stats", "bw", "tl"} <= {p.id for p in spec.panels}
    assert DashboardSpec(**spec.model_dump()) == spec


def test_panel_spec_defaults():
    p = PanelSpec(id="x", type="stat")
    assert p.grid == GridPos(x=0, y=0, w=12, h=4)
