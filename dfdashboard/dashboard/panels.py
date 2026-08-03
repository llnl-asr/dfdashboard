"""Built-in panel factories, registered by type."""

from __future__ import annotations

import io

import panel as pn
import pyarrow as pa
from bokeh.models import ColumnDataSource
from bokeh.plotting import figure

from ..analysis.panel_app import DIVIDER, MUTED, PANEL_BG, READ, WRITE, _tile, theme_figure
from ..widgets import TimelineWidget
from .model import PanelSpec
from .registry import register


def _fmt_bytes(n: float) -> str:
    x = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if x < 1000 or unit == "TB":
            return f"{x:.0f} {unit}" if unit == "B" else f"{x:.1f} {unit}"
        x /= 1000.0
    return f"{x:.1f} TB"


@register("stat")
def _stat(spec: PanelSpec, ctx) -> pn.viewable.Viewable:
    info = ctx.trace.info()
    span = (info.global_max_ts - info.global_min_ts) / 1e6
    hosts = len(set(info.hosts.values())) or (1 if info.pids else 0)
    return pn.FlexBox(
        _tile("Job span", f"{span:.1f}s"),
        _tile("Events", f"{info.num_events:,}"),
        _tile("Files", str(info.file_count)),
        _tile("I/O bytes", _fmt_bytes(info.total_bytes or 0)),
        _tile("Processes", str(len(info.pids))),
        _tile("Hosts", str(hosts)),
        sizing_mode="stretch_width",
    )


@register("timeline")
def _timeline(spec: PanelSpec, ctx) -> pn.viewable.Viewable:
    height = max(spec.grid.h * 64, 360)
    return TimelineWidget(trace=ctx.trace, sizing_mode="stretch_width", height=height)


@register("bandwidth")
def _bandwidth(spec: PanelSpec, ctx) -> pn.viewable.Viewable:
    info = ctx.trace.info()
    span = float(info.global_max_ts - info.global_min_ts)
    buckets = int(spec.options.get("buckets", 200))
    tbl = pa.ipc.open_stream(
        io.BytesIO(ctx.trace.counters_arrow(0.0, span, buckets, None))
    ).read_all()
    read = tbl.column("read_bytes").to_pylist()
    write = tbl.column("write_bytes").to_pylist()
    bucket_s = max((span / buckets) / 1e6, 1e-9)
    xs = [i * (span / buckets) / 1e6 for i in range(len(read))]
    src = ColumnDataSource(
        {
            "x": xs,
            "read": [b / bucket_s / 1e6 for b in read],
            "write": [b / bucket_s / 1e6 for b in write],
        }
    )
    p = figure(height=260, sizing_mode="stretch_width", toolbar_location=None, tools="")
    p.varea(x="x", y1=0, y2="read", source=src, fill_color=READ, fill_alpha=0.18)
    p.varea(x="x", y1=0, y2="write", source=src, fill_color=WRITE, fill_alpha=0.18)
    p.line("x", "read", source=src, line_color=READ, line_width=2, legend_label="read")
    p.line("x", "write", source=src, line_color=WRITE, line_width=2, legend_label="write")
    theme_figure(p)
    p.legend.location = "top_right"
    p.legend.background_fill_color = PANEL_BG
    p.legend.border_line_color = DIVIDER
    p.legend.label_text_color = MUTED
    p.xaxis.axis_label = "time (s)"
    p.yaxis.axis_label = "MB/s"
    return pn.pane.Bokeh(p, sizing_mode="stretch_width")
