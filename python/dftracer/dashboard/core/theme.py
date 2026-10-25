"""The one palette.

A Bokeh canvas is painted server-side, so its colors come from the theme the page
embedded it with, and a theme switch re-embeds. Card HTML reads the page's own
CSS variables instead, so it follows a switch without a round trip. Both read
their values from here.

web/src/timeline/theme.ts carries the same dark and light values for the canvas
timeline; tests/test_theme.py fails when the two drift apart.
"""

from __future__ import annotations

from typing import Any

from bokeh.themes import Theme

DARK: dict[str, str] = {
    "plot": "#0a0b0a",
    "panel": "#0c0e0b",
    "ink": "#e6e2ce",
    "muted": "#8a927c",
    "accent": "#e6a13c",
    "hair": "#16180f",
    "grid": "#16180f",
    "divider": "#1f2119",
    "read": "#4bb0c4",
    "write": "#e6a13c",
}
LIGHT: dict[str, str] = {
    "plot": "#fffdf7",
    "panel": "#f1ece2",
    "ink": "#2a2620",
    "muted": "#6f6656",
    "accent": "#c2740f",
    "hair": "#eee8dc",
    "grid": "#f0eadd",
    "divider": "#e2dccd",
    "read": "#2c8296",
    "write": "#bf7d1e",
}

# CSS custom properties the SPA defines in web/src/styles.css, with the dark
# value as the fallback so a card is readable before the page sets a theme.
V_PLOT = "var(--bg, #0a0b0a)"
V_PANEL = "var(--panel, #0c0e0b)"
V_INK = "var(--text-hi, #e6e2ce)"
V_MUTED = "var(--muted, #8a927c)"
V_ACCENT = "var(--accent, #e6a13c)"
V_HAIR = "var(--hair, #16180f)"

FONT = "'SFMono-Regular', ui-monospace, monospace"

_THEMES: dict[str, Theme] = {}


def palette(mode: str) -> dict[str, str]:
    return LIGHT if mode == "light" else DARK


def _attrs(c: dict[str, str]) -> dict[str, Any]:
    return {
        # "Figure" is not a theme key: Bokeh matches the model type name, so the
        # plot background and border belong under "Plot".
        "Plot": {
            "background_fill_color": c["plot"],
            "border_fill_color": c["panel"],
            "outline_line_color": c["hair"],
        },
        "Axis": {
            "axis_line_color": c["divider"],
            "major_tick_line_color": c["divider"],
            "minor_tick_line_color": None,
            "major_label_text_color": c["muted"],
            "axis_label_text_color": c["muted"],
            "major_label_text_font": FONT,
            "axis_label_text_font": FONT,
            "major_label_text_font_size": "10px",
            "axis_label_text_font_size": "11px",
            "axis_label_standoff": 3,
        },
        "Grid": {"grid_line_color": c["grid"]},
        "Legend": {
            "background_fill_color": c["panel"],
            "border_line_color": c["divider"],
            "label_text_color": c["muted"],
            "label_text_font": FONT,
        },
    }


def bokeh_theme(mode: str) -> Theme:
    """One document theme per mode, so a figure carries no color of its own."""
    if mode not in _THEMES:
        _THEMES[mode] = Theme(json={"attrs": _attrs(palette(mode))})
    return _THEMES[mode]
