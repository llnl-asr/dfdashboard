"""The Bokeh figure every canvas card draws into.

Colors and fonts are not set here: the card application assigns a document theme
(core.theme.bokeh_theme) before any card builds its figure, so a figure carries
layout only.
"""

from __future__ import annotations

from bokeh.models import DataRange1d
from bokeh.plotting import figure


def themed_figure(x_axis_type: str = "linear") -> "figure":
    return figure(
        sizing_mode="stretch_both",
        toolbar_location=None,
        tools="",
        output_backend="webgl",
        y_range=DataRange1d(start=0),
        x_axis_type=x_axis_type,  # ty: ignore[invalid-argument-type]
        min_border_top=8,
        min_border_right=14,
        min_border_left=58,  # y-axis labels
        min_border_bottom=52,  # x-axis ticks + label
    )
