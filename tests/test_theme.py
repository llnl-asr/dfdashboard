"""The Python palette and the canvas timeline palette must not drift apart.

core/theme.py paints the Bokeh cards and the Panel views; web/src/timeline/theme.ts
paints the timeline canvas. The same trace read in two places should not come out
in two different greens, so the shared keys are compared here.
"""

import re
from pathlib import Path

from dftracer.dashboard.core import theme

ROOT = Path(__file__).resolve().parents[1]
TS = ROOT / "web" / "src" / "timeline" / "theme.ts"

# Python palette key -> TypeScript VizTheme key.
SHARED = {
    "plot": "plotBg",
    "panel": "panelBg",
    "grid": "grid",
    "divider": "divider",
    "ink": "groupText",
    "muted": "laneText",
    "accent": "accent",
    "read": "read",
    "write": "write",
}


def _ts_block(name: str) -> dict[str, str]:
    text = TS.read_text()
    body = text.split(f"const {name}: VizTheme = {{", 1)[1].split("};", 1)[0]
    return {k.lower(): v.lower() for k, v in re.findall(r"(\w+):\s*\"([^\"]+)\"", body)}


def test_both_modes_carry_the_same_keys():
    assert set(theme.DARK) == set(theme.LIGHT)


def test_the_card_palette_matches_the_timeline_palette():
    for mode, py in (("dark", theme.DARK), ("light", theme.LIGHT)):
        ts = _ts_block(mode.upper())
        for key, ts_key in SHARED.items():
            assert py[key].lower() == ts[ts_key.lower()], f"{mode} {key} vs {ts_key}"


def test_html_fallbacks_are_the_dark_values():
    for var, key in (
        (theme.V_PLOT, "plot"),
        (theme.V_PANEL, "panel"),
        (theme.V_INK, "ink"),
        (theme.V_MUTED, "muted"),
        (theme.V_ACCENT, "accent"),
        (theme.V_HAIR, "hair"),
    ):
        assert theme.DARK[key] in var


def test_one_theme_per_mode_is_reused():
    assert theme.bokeh_theme("dark") is theme.bokeh_theme("dark")
    assert theme.bokeh_theme("light") is not theme.bokeh_theme("dark")


def test_the_document_theme_paints_the_plot_surface():
    # Bokeh matches theme keys against the model type name, so a Figure key
    # silently does nothing while Grid and Axis still apply.
    from bokeh.document import Document
    from bokeh.plotting import figure

    doc = Document()
    doc.theme = theme.bokeh_theme("dark")
    fig = figure()
    doc.add_root(fig)
    assert fig.background_fill_color == theme.DARK["plot"]
    assert fig.border_fill_color == theme.DARK["panel"]
    assert fig.outline_line_color == theme.DARK["hair"]
