"""Overview compute cards, each a Dask pipeline pushed over one shared Bokeh session.

Each card is a named document root; the Solid overview mounts root `pcard-<card_id>`
into its own grid cell, so pushed and instant cards share one grid and one websocket.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Optional

import panel as pn
from bokeh.application import Application
from bokeh.application.handlers.function import FunctionHandler
from bokeh.models import ColumnDataSource, DataRange1d
from bokeh.plotting import figure

from ..runtime.tasks import TERMINAL, Lane, TaskSpec, TaskState
from .base import RunContext, get_pipeline
from .docloop import spawn
from .pipelines import CardComputeParams

log = logging.getLogger(__name__)

CARDS_PATH = "/cards"
REFRESH_S = 10.0

# A Bokeh canvas is painted server-side, so its colors come from the theme the
# page embedded it with, and a theme switch re-embeds. Card HTML reads the page's
# own CSS variables instead, so it follows a switch without a round trip.
_DARK = {
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
_LIGHT = {
    "plot": "#fffdf7",
    "panel": "#f1ece2",
    "ink": "#2a2620",
    "muted": "#6f6656",
    "accent": "#c2740f",
    "hair": "#eee8dc",
    "grid": "#ece6d9",
    "divider": "#ddd6c8",
    "read": "#1f7f92",
    "write": "#c2740f",
}
V_PLOT = "var(--bg, #0a0b0a)"
V_PANEL = "var(--panel, #0c0e0b)"
V_INK = "var(--text-hi, #e6e2ce)"
V_MUTED = "var(--muted, #8a927c)"
V_ACCENT = "var(--accent, #e6a13c)"
V_HAIR = "var(--hair, #16180f)"
FONT = "'SFMono-Regular', ui-monospace, monospace"

# Inlined as a scoped <style> inside each card's HTML pane; Panel isolates a
# component's stylesheets to its own shadow root, so a shared sheet on the outer
# layout would not reach the pane content.
_CARD_CSS = f"""
.pcard {{ background:{V_PANEL}; border:1px solid {V_HAIR}; border-radius:6px;
  padding:14px 16px; font-family:{FONT}; box-sizing:border-box; color:{V_INK};
  height:100%; overflow:hidden; display:flex; flex-direction:column; }}
.pcard-head {{ flex:0 0 auto; }}
.pcard-body {{ flex:1 1 auto; min-height:0; overflow:auto; scrollbar-width:thin;
  scrollbar-color:{V_MUTED} transparent; }}
.pcard-body::-webkit-scrollbar {{ width:8px; height:8px; }}
.pcard-body::-webkit-scrollbar-thumb {{ background:{V_HAIR}; border-radius:4px; }}
.pcard-body::-webkit-scrollbar-thumb:hover {{ background:{V_MUTED}; }}
.pcard-body::-webkit-scrollbar-track {{ background:transparent; }}
.pcard-head {{ font-size:12px; font-weight:500; letter-spacing:.05em;
  text-transform:uppercase; color:{V_INK}; margin-bottom:12px; }}
.pcard-load {{ font-size:12px; color:{V_MUTED}; }}
.pcard-busy {{ display:flex; align-items:center; gap:8px; }}
.pcard-dot {{ width:10px; height:10px; border-radius:50%; flex:0 0 auto;
  border:2px solid {V_HAIR}; border-top-color:{V_ACCENT};
  animation:pcard-spin .8s linear infinite; }}
@keyframes pcard-spin {{ to {{ transform:rotate(360deg); }} }}
.pcard-err {{ font-size:12px; color:#d08770; }}
.pcard-note {{ font-size:10px; color:{V_MUTED}; margin-top:10px; }}
.cbars {{ display:flex; flex-direction:column; gap:8px; }}
.cbar-row {{ display:grid; grid-template-columns:150px 1fr auto; align-items:center;
  gap:12px; font-size:12px; color:{V_INK}; }}
.cbar-name {{ overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }}
.cbar-track {{ height:8px; background:{V_PLOT}; border-radius:4px; overflow:hidden; }}
.cbar-fill {{ display:block; height:100%; border-radius:4px; min-width:2px;
  background:{V_ACCENT}; }}
.cbar-val {{ color:{V_MUTED}; font-variant-numeric:tabular-nums; }}
.pcard-err {{ font-size:12px; color:#d08770; }}
.pcard-note {{ font-size:10px; color:{V_MUTED}; margin-top:10px; }}
.cbars {{ display:flex; flex-direction:column; gap:8px; }}
.cbar-row {{ display:grid; grid-template-columns:150px 1fr auto; align-items:center;
  gap:12px; font-size:12px; color:{V_INK}; }}
.cbar-name {{ overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }}
.cbar-track {{ height:8px; background:{V_PLOT}; border-radius:4px; overflow:hidden; }}
.cbar-fill {{ display:block; height:100%; border-radius:4px; min-width:2px;
  background:{V_ACCENT}; }}
.cbar-val {{ color:{V_MUTED}; font-variant-numeric:tabular-nums; }}
.ctable {{ display:flex; flex-direction:column; gap:4px; font-size:12px; color:{V_INK};
  font-variant-numeric:tabular-nums; }}
.ctable-head, .ctable-row {{ display:grid; gap:8px; align-items:center;
  grid-template-columns:minmax(90px,1.6fr) 76px 84px 64px 80px 84px 68px; }}
.ctable-head span:nth-child(n+4), .ctable-row .num {{ text-align:right; }}
.ctable-head {{ font-size:10px; letter-spacing:.05em; text-transform:uppercase;
  color:{V_MUTED}; padding-bottom:4px; border-bottom:1px solid {V_HAIR}; }}
.ctable-row {{ padding:1px 0; }}
.ctable-name {{ overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }}
.ctable-row .num {{ color:{V_MUTED}; }}
.cstate::before {{ content:""; display:inline-block; width:6px; height:6px; border-radius:3px;
  margin-right:5px; vertical-align:middle; background:{V_MUTED}; }}
.cstate.live::before {{ background:#6fbf73; }}
.cstate.stalled::before {{ background:#e6a13c; }}
"""


WAITING = "waiting for the first trace records"
EMPTY = "no rows in this window"


def _busy(text: str = WAITING) -> str:
    return f'<div class="pcard-busy"><span class="pcard-dot"></span>{text}</div>'


def _card_html(title: str, inner: str) -> str:
    return (
        f"<style>{_CARD_CSS}</style>"
        f'<div class="pcard"><div class="pcard-head">{title}</div>'
        f'<div class="pcard-body">{inner}</div></div>'
    )


def _html_card(title: str, placeholder: str = WAITING) -> pn.pane.HTML:
    return pn.pane.HTML(
        _card_html(title, _busy(placeholder)),
        sizing_mode="stretch_both",
        margin=0,
    )


def _fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if abs(n) < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} EB"


def _fmt_time(s: float) -> str:
    if s >= 1:
        return f"{s:.2f} s"
    if s >= 1e-3:
        return f"{s * 1e3:.0f} ms"
    return f"{s * 1e6:.0f} us"


# rows: (name, magnitude, label); magnitude drives bar width, label is shown.
def _bars(rows: list[tuple[str, float, str]]) -> str:
    mx = max((v for _, v, _ in rows), default=1) or 1

    def _row(name: str, v: float, label: str) -> str:
        w = max(2, v / mx * 100)
        bar = f'<span class="cbar-fill" style="width:{w:.1f}%"></span>'
        return (
            f'<div class="cbar-row"><span class="cbar-name" title="{name}">{name}</span>'
            f'<span class="cbar-track">{bar}</span>'
            f'<span class="cbar-val">{label}</span></div>'
        )

    if not rows:
        return _busy(EMPTY)
    return f'<div class="cbars">{"".join(_row(*r) for r in rows)}</div>'


_FULL_TRACE = '<div class="pcard-note">full trace (not filtered)</div>'


def _io_by_host(app: Any, theme: str) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
    title = "I/O by host"
    card = _html_card(title)

    async def fill(doc: Any) -> None:
        try:
            # No cache: a cached empty-param spec kept the first result forever,
            # so the card showed the hosts that existed when it first painted.
            spec = TaskSpec(pipeline_id="io_summary", lane=Lane.NORMAL)
            res = await _run_task(app, spec) if _has_trace(app) else None
            if res is None:
                inner = _busy()
            else:
                pairs = sorted(res.data["bytes_by_host"].items(), key=lambda kv: -kv[1])[:12]
                inner = _bars([(h, float(v), _fmt_bytes(v)) for h, v in pairs]) + _FULL_TRACE
        except Exception as exc:  # surface the failure in the card, not the log only
            inner = f'<div class="pcard-err">{exc}</div>'

        def apply() -> None:
            card.object = _card_html(title, inner)
            card.loading = False

        doc.add_next_tick_callback(apply)

    return card, fill


_WRAP_CSS = (
    f":host {{ display:block; background:{V_PANEL}; border:1px solid {V_HAIR}; "
    f"border-radius:6px; padding:14px 16px; box-sizing:border-box; height:100%; }}"
    f".pcard-busy {{ display:flex; align-items:center; gap:8px; font-size:12px;"
    f"color:{V_MUTED}; font-family:{FONT}; }}"
    f".pcard-dot {{ width:10px; height:10px; border-radius:50%; flex:0 0 auto;"
    f"border:2px solid {V_HAIR}; border-top-color:{V_ACCENT};"
    f"animation:pcard-spin .8s linear infinite; }}"
    f"@keyframes pcard-spin {{ to {{ transform:rotate(360deg); }} }}"
)


def _head(title: str) -> pn.pane.HTML:
    return pn.pane.HTML(
        f'<div style="font-size:12px;font-weight:500;letter-spacing:.05em;'
        f'text-transform:uppercase;color:{V_INK};font-family:{FONT}">{title}</div>',
        margin=(0, 0, 10, 0),
        sizing_mode="stretch_width",
    )


def _wrap(title: str, body: pn.viewable.Viewable) -> tuple[pn.Column, pn.pane.HTML]:
    """The card column plus the status it shows in the head until data lands.

    The status sits in the header row: inside the column it stole height from
    the plot, which then drew into a shrunken box.
    """
    head = _head(title)
    head.margin = 0
    status = pn.pane.HTML(
        _busy(WAITING), margin=(0, 0, 0, 10), align="end", sizing_mode="stretch_width"
    )
    column = pn.Column(
        pn.Row(head, status, sizing_mode="stretch_width", margin=(0, 0, 10, 0)),
        body,
        stylesheets=[_WRAP_CSS],
        sizing_mode="stretch_both",
        margin=0,
    )
    return column, status


def _qargs(doc: Any) -> dict[str, str]:
    try:
        args = doc.session_context.request.arguments or {}
    except Exception:
        return {}
    out: dict[str, str] = {}
    for k, v in args.items():
        if v:
            val = v[0]
            out[k] = val.decode() if isinstance(val, (bytes, bytearray)) else str(val)
    return out


async def _run_task(app: Any, spec: TaskSpec) -> Any:
    """Run a pipeline through the task backend and return its Result. Cancels the
    backend task if this coroutine is cancelled (session torn down by a filter
    change). Falls back to running the pipeline inline when no backend exists."""
    backend = getattr(app.state, "backend", None)
    events = getattr(app.state, "events", None)
    if backend is None or events is None:
        pipeline = get_pipeline(spec.pipeline_id)
        if pipeline is None:
            return None
        cluster = getattr(app.state, "cluster", None)
        ctx = RunContext(
            data=getattr(app.state, "trace", None),
            client_provider=(cluster.client if cluster else None),
        )
        return await pipeline.run(ctx, pipeline.Params(**spec.params))

    q = events.listen("task")
    task_id: Optional[str] = None
    try:
        task_id = await backend.submit(spec)
        while True:
            rec = backend.get(task_id)
            if rec is not None and rec.state in TERMINAL:
                break
            await q.get()  # woken by any task event; re-check our record
        if rec is None or rec.state != TaskState.DONE:
            raise RuntimeError((rec and rec.error) or "task failed")
        return rec.result
    except asyncio.CancelledError:
        if task_id is not None:
            await backend.cancel(task_id)
        raise
    finally:
        events.unlisten("task", q)


def _has_trace(app: Any) -> bool:
    """Whether any trace is loaded, asking the watcher when one is running.

    In watch mode the tree starts empty, so `app.state.trace` stays None while
    the current trace comes from the registry.
    """
    registry = getattr(app.state, "registry", None)
    if registry is not None:
        return registry.trace() is not None
    return getattr(app.state, "trace", None) is not None


async def _compute(app: Any, doc: Any, op: str, n: int = 120, nbuckets: int = 48) -> Any:
    """Run this card's window through the `card_compute` task and return its Result."""
    if not _has_trace(app):
        return None
    a = _qargs(doc)
    try:
        begin = float(a.get("begin") or 0.0)
        end = float(a.get("end") or 0.0)
    except ValueError:
        begin, end = 0.0, 0.0
    query = (a.get("query") or "").strip() or None
    params = CardComputeParams(op=op, begin=begin, end=end, query=query, n=n, nbuckets=nbuckets)
    spec = TaskSpec(pipeline_id="card_compute", params=params.model_dump(), lane=Lane.INTERACTIVE)
    return await _run_task(app, spec)


def _palette(theme: str) -> dict[str, str]:
    return _LIGHT if theme == "light" else _DARK


def _theme(doc: Any) -> str:
    return "light" if _qargs(doc).get("theme") == "light" else "dark"


def _themed_figure(theme: str, x_axis_type: str = "linear") -> figure:
    c = _palette(theme)
    p = figure(
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
    p.background_fill_color = c["plot"]
    p.border_fill_color = c["panel"]
    p.outline_line_color = c["hair"]
    p.grid.grid_line_color = c["grid"]
    p.axis.axis_line_color = c["divider"]
    p.axis.major_tick_line_color = c["divider"]
    p.axis.minor_tick_line_color = None
    p.axis.major_label_text_color = c["muted"]
    p.axis.major_label_text_font = FONT
    p.axis.major_label_text_font_size = "10px"
    p.axis.axis_label_text_font_size = "11px"
    p.axis.axis_label_standoff = 3
    return p


def _bandwidth(app: Any, theme: str) -> tuple[pn.viewable.Viewable, Callable[[Any], Any]]:
    c = _palette(theme)
    src = ColumnDataSource({"x": [], "read": [], "write": []})
    p = _themed_figure(theme)
    p.line("x", "read", source=src, line_color=c["read"], line_width=2, legend_label="read")
    p.line("x", "write", source=src, line_color=c["write"], line_width=2, legend_label="write")
    p.legend.location = "top_left"
    p.legend.background_fill_color = c["panel"]
    p.legend.border_line_color = c["divider"]
    p.legend.label_text_color = c["muted"]
    p.legend.label_text_font = FONT
    p.xaxis.axis_label = "seconds"
    p.xaxis.axis_label_text_color = c["muted"]
    p.xaxis.axis_label_text_font = FONT
    card, status = _wrap("I/O bandwidth (GB/s)", pn.pane.Bokeh(p, sizing_mode="stretch_both"))

    async def fill(doc: Any) -> None:
        import io as _io

        import pyarrow.ipc as ipc

        n = 120
        res = await _compute(app, doc, "counters", n=n)
        if res is None:
            return
        tbl = ipc.open_stream(_io.BytesIO(res.data)).read_all()
        read = tbl.column("read_bytes").to_pylist()
        write = tbl.column("write_bytes").to_pylist()
        window = res.meta["end"] - res.meta["begin"]
        bucket_s = max((window / n) / 1e6, 1e-9)
        # Elapsed seconds at each bucket center, not the raw bucket index.
        xs = [(i + 0.5) * bucket_s for i in range(n)]
        rs = [r / bucket_s / 1e9 for r in read]
        ws = [w / bucket_s / 1e9 for w in write]

        def apply() -> None:
            src.data.update({"x": xs, "read": rs, "write": ws})
            status.visible = False

        doc.add_next_tick_callback(apply)

    return card, fill


_OP_ORDER = ["read", "write", "open", "close", "stat", "seek", "sync"]
_META_OPS = ["open", "close", "stat", "seek", "sync"]


def _rows_op_time(st: dict) -> list[tuple[str, float, str]]:
    rows = [
        (op, st[op]["time"], _fmt_time(st[op]["time"])) for op in _OP_ORDER if st[op]["time"] > 0
    ]
    return sorted(rows, key=lambda r: -r[1])


def _rows_op_counts(st: dict) -> list[tuple[str, float, str]]:
    rows = [
        (op, float(st[op]["count"]), f"{int(st[op]['count']):,}")
        for op in _OP_ORDER
        if st[op]["count"] > 0
    ]
    return sorted(rows, key=lambda r: -r[1])


def _rows_busiest(procs: list[dict[str, Any]]) -> list[tuple[str, float, str]]:
    top = sorted(procs, key=lambda p: -p["bytes"])[:12]
    return [
        (f"proc {p['pid']}", float(p["bytes"]), _fmt_bytes(p["bytes"]))
        for p in top
        if p["bytes"] > 0
    ]


def _rows_read_write(st: dict) -> list[tuple[str, float, str]]:
    return [(op, float(st[op]["bytes"]), _fmt_bytes(st[op]["bytes"])) for op in ("read", "write")]


def _rows_avg_xfer(st: dict) -> list[tuple[str, float, str]]:
    out = []
    for op in ("read", "write"):
        c, b = st[op]["count"], st[op]["bytes"]
        if c > 0:
            out.append((op, b / c, _fmt_bytes(b / c)))
    return out


def _rows_data_meta(st: dict) -> list[tuple[str, float, str]]:
    data = st["read"]["time"] + st["write"]["time"]
    meta = sum(st[op]["time"] for op in _META_OPS)
    return [("data", data, _fmt_time(data)), ("metadata", meta, _fmt_time(meta))]


def _rows_bw_by_host(procs: list[dict[str, Any]]) -> list[tuple[str, float, str]]:
    moved: dict[str, list[float]] = {}
    for p in procs:
        acc = moved.setdefault(str(p["host"]), [0.0, 0.0])
        acc[0] += float(p["bytes"])
        acc[1] += float(p["time_us"])
    rows = []
    for host, (size, busy_us) in moved.items():
        bw = size / (busy_us / 1e6) if busy_us > 0 else 0.0
        rows.append((host, bw, f"{_fmt_bytes(bw)}/s"))
    return sorted(rows, key=lambda r: -r[1])[:12]


# Bar card over one card_compute op; responds to the window filter.
def _bar_card(
    title: str, op: str, rows: Callable[[Any], list[tuple[str, float, str]]]
) -> Callable[[Any, str], tuple[pn.pane.HTML, Callable[[Any], Any]]]:
    def builder(app: Any, theme: str) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
        card = _html_card(title, "loading...")

        async def fill(doc: Any) -> None:
            try:
                res = await _compute(app, doc, op)
                inner = _bars(rows(res.data)) if res else _busy()
            except Exception as exc:
                inner = f'<div class="pcard-err">{exc}</div>'

            def apply() -> None:
                card.object = _card_html(title, inner)
                card.loading = False

            doc.add_next_tick_callback(apply)

        return card, fill

    return builder


def _latency(app: Any, theme: str) -> tuple[pn.viewable.Viewable, Callable[[Any], Any]]:
    c = _palette(theme)
    src = ColumnDataSource({"x": [], "count": []})
    p = _themed_figure(theme, x_axis_type="log")
    p.varea(x="x", y1=0, y2="count", source=src, fill_color=c["read"], fill_alpha=0.35)
    p.line("x", "count", source=src, line_color=c["read"], line_width=2)
    p.xaxis.axis_label = "duration (us)"
    p.xaxis.axis_label_text_color = c["muted"]
    p.xaxis.axis_label_text_font = FONT
    card, status = _wrap("Operation latency", pn.pane.Bokeh(p, sizing_mode="stretch_both"))

    async def fill(doc: Any) -> None:
        res = await _compute(app, doc, "histogram", n=60)
        if res is None:
            return
        xs, cs = [], []
        for b in res.data.get("buckets", []):
            lo, hi = float(b["lo"]), float(b["hi"])
            xs.append((lo * hi) ** 0.5 if lo > 0 and hi > 0 else max(lo, 1e-3))
            cs.append(int(b["count"]))

        def apply() -> None:
            src.data.update({"x": xs, "count": cs})
            status.visible = False

        doc.add_next_tick_callback(apply)

    return card, fill


def _xfer_hist(app: Any, theme: str) -> tuple[pn.viewable.Viewable, Callable[[Any], Any]]:
    c = _palette(theme)
    src = ColumnDataSource({"x": [], "count": []})
    p = _themed_figure(theme, x_axis_type="log")
    p.varea(x="x", y1=0, y2="count", source=src, fill_color=c["write"], fill_alpha=0.35)
    p.line("x", "count", source=src, line_color=c["write"], line_width=2)
    p.xaxis.axis_label = "bytes"
    p.xaxis.axis_label_text_color = c["muted"]
    p.xaxis.axis_label_text_font = FONT
    card, status = _wrap("Transfer sizes", pn.pane.Bokeh(p, sizing_mode="stretch_both"))

    async def fill(doc: Any) -> None:
        res = await _compute(app, doc, "size_histogram", nbuckets=48)
        if res is None:
            return
        xs, cs = [], []
        for b in res.data.get("buckets", []):
            lo, hi = float(b["lo"]), float(b["hi"])
            xs.append((lo * hi) ** 0.5 if lo > 0 and hi > 0 else max(lo, 1.0))
            cs.append(int(b["count"]))

        def apply() -> None:
            src.data.update({"x": xs, "count": cs})
            status.visible = False

        doc.add_next_tick_callback(apply)

    return card, fill


def _access_pattern(app: Any, theme: str) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
    title = "Access pattern"
    card = _html_card(title, "analyzing trace...")

    async def fill(doc: Any) -> None:
        try:
            res = await _compute(app, doc, "access_pattern")
            if res is None:
                inner = _busy()
            else:
                ap = res.data
                total = (ap["sequential"] + ap["random"]) or 1
                rows = [
                    (
                        label,
                        float(v),
                        f"{v:,} ({v / total * 100:.1f}%)",
                    )
                    for label, v in (("sequential", ap["sequential"]), ("random", ap["random"]))
                ]
                note = (
                    "exact, by read offsets"
                    if ap.get("method") == "offset"
                    else "estimated from seeks"
                )
                inner = _bars(rows) + f'<div class="pcard-note">{note}</div>'
        except Exception as exc:
            inner = f'<div class="pcard-err">{exc}</div>'

        def apply() -> None:
            card.object = _card_html(title, inner)
            card.loading = False

        doc.add_next_tick_callback(apply)

    return card, fill


# id -> builder; each builder returns (view, async fill(doc)).
_BUILDERS: dict[str, Callable[[Any, str], tuple[pn.viewable.Viewable, Callable[[Any], Any]]]] = {
    "io_summary": _io_by_host,
    "bandwidth": _bandwidth,
    "latency": _latency,
    "xfer_hist": _xfer_hist,
    "access_pattern": _access_pattern,
    "op_time": _bar_card("I/O time by operation", "op_stats", _rows_op_time),
    "op_counts": _bar_card("Operation counts", "op_stats", _rows_op_counts),
    "read_write": _bar_card("Read vs write (bytes)", "op_stats", _rows_read_write),
    "avg_xfer": _bar_card("Avg transfer size", "op_stats", _rows_avg_xfer),
    "data_meta": _bar_card("Data vs metadata time", "op_stats", _rows_data_meta),
    "bw_by_host": _bar_card("Bandwidth by host", "proc_bytes", _rows_bw_by_host),
    "busiest": _bar_card("Busiest processes (I/O bytes)", "proc_bytes", _rows_busiest),
}


def card_ids() -> list[str]:
    return list(_BUILDERS)


def _version(app: Any) -> Optional[int]:
    """The watched tree's change counter, or None when nothing can change."""
    registry = getattr(app.state, "registry", None)
    return registry.seq if registry is not None else None


async def _live(app: Any, cid: str, fill: Callable[[Any], Any], doc: Any) -> None:
    """Paint a card, then repaint it when the watched tree changes.

    One sequential loop per card, so a slow fill never stacks up behind itself
    and an idle tree costs one integer compare per REFRESH_S.
    """
    seen = _version(app)
    while True:
        try:
            await fill(doc)
        except asyncio.CancelledError:
            raise
        except Exception:  # a dead loop would freeze the card silently
            log.exception("card %s failed", cid)
        if seen is None:
            return
        while True:
            await asyncio.sleep(REFRESH_S)
            now = _version(app)
            if now != seen:
                seen = now
                break


def build_cards_app(app: Any) -> Application:
    def modify_doc(doc: Any) -> None:
        jobs: list[asyncio.Future] = []
        theme = _theme(doc)
        for cid, builder in _BUILDERS.items():
            view, fill = builder(app, theme)
            root = view.get_root(doc)
            root.name = cid
            if root not in doc.roots:
                doc.add_root(root)
            jobs.append(spawn(app, _live(app, cid, fill, doc)))

        def _cleanup(_ctx: Any) -> None:
            for j in jobs:
                j.cancel()

        doc.on_session_destroyed(_cleanup)

    return Application(FunctionHandler(modify_doc))
