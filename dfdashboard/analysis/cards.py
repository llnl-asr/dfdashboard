"""Overview compute cards, each a Dask pipeline pushed over one shared Bokeh session.

Each card is a named document root; the Solid overview mounts root `pcard-<card_id>`
into its own grid cell, so pushed and instant cards share one grid and one websocket.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Callable, Optional

import panel as pn
from bokeh.application import Application
from bokeh.application.handlers.function import FunctionHandler
from bokeh.models import ColumnDataSource, DataRange1d
from bokeh.plotting import figure

from ..runtime.tasks import TERMINAL, Lane, TaskSpec, TaskState
from .base import RunContext, get_pipeline
from .pipelines import CardComputeParams

CARDS_PATH = "/cards"

PLOT_BG, PANEL_BG, INK, MUTED, ACCENT, HAIR = (
    "#0a0b0a",
    "#0c0e0b",
    "#e6e2ce",
    "#8a927c",
    "#e6a13c",
    "#16180f",
)
GRID, DIVIDER, READ, WRITE = "#16180f", "#1f2119", "#4bb0c4", "#e6a13c"
FONT = "'SFMono-Regular', ui-monospace, monospace"

# Inlined as a scoped <style> inside each card's HTML pane; Panel isolates a
# component's stylesheets to its own shadow root, so a shared sheet on the outer
# layout would not reach the pane content.
_CARD_CSS = f"""
.pcard {{ background:{PANEL_BG}; border:1px solid {HAIR}; border-radius:6px;
  padding:14px 16px; font-family:{FONT}; box-sizing:border-box;
  height:100%; overflow:auto; }}
.pcard-head {{ font-size:12px; font-weight:500; letter-spacing:.05em;
  text-transform:uppercase; color:{INK}; margin-bottom:12px; }}
.pcard-load {{ font-size:12px; color:{MUTED}; }}
.pcard-err {{ font-size:12px; color:#d08770; }}
.pcard-note {{ font-size:10px; color:{MUTED}; margin-top:10px; }}
.cbars {{ display:flex; flex-direction:column; gap:8px; }}
.cbar-row {{ display:grid; grid-template-columns:150px 1fr auto; align-items:center;
  gap:12px; font-size:12px; color:{INK}; }}
.cbar-name {{ overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }}
.cbar-track {{ height:8px; background:{PLOT_BG}; border-radius:4px; overflow:hidden; }}
.cbar-fill {{ display:block; height:100%; border-radius:4px; background:{ACCENT}; min-width:2px; }}
.cbar-val {{ color:{MUTED}; font-variant-numeric:tabular-nums; }}
"""


def _card_html(title: str, inner: str) -> str:
    return (
        f"<style>{_CARD_CSS}</style>"
        f'<div class="pcard"><div class="pcard-head">{title}</div>{inner}</div>'
    )


def _html_card(title: str, placeholder: str) -> pn.pane.HTML:
    return pn.pane.HTML(
        _card_html(title, f'<div class="pcard-load">{placeholder}</div>'),
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
        return '<div class="pcard-load">no data</div>'
    return f'<div class="cbars">{"".join(_row(*r) for r in rows)}</div>'


def _io_by_host(app: Any) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
    title = "I/O by host"
    card = _html_card(title, "computing on cluster...")

    async def fill(doc: Any) -> None:
        try:
            spec = TaskSpec(pipeline_id="io_summary", lane=Lane.NORMAL, cache=True)
            res = await _run_task(app, spec)
            if res is None:
                inner = '<div class="pcard-load">no trace</div>'
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
    f":host {{ display:block; background:{PANEL_BG}; border:1px solid {HAIR}; "
    f"border-radius:6px; padding:14px 16px; box-sizing:border-box; height:100%; }}"
)


def _head(title: str) -> pn.pane.HTML:
    return pn.pane.HTML(
        f'<div style="font-size:12px;font-weight:500;letter-spacing:.05em;'
        f'text-transform:uppercase;color:{INK};font-family:{FONT}">{title}</div>',
        margin=(0, 0, 10, 0),
        sizing_mode="stretch_width",
    )


def _wrap(title: str, body: pn.viewable.Viewable) -> pn.Column:
    return pn.Column(
        _head(title), body, stylesheets=[_WRAP_CSS], sizing_mode="stretch_both", margin=0
    )


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


async def _compute(app: Any, doc: Any, op: str, n: int = 120, nbuckets: int = 48) -> Any:
    """Run this card's window through the `card_compute` task and return its Result."""
    if getattr(app.state, "trace", None) is None:
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


async def _dfa(app: Any) -> Any:
    """Run dfanalyzer once through the backend (deduped + result-cached across
    re-embeds) and return its Result; data carries `main_view_path`."""
    trace = getattr(app.state, "trace", None)
    if trace is None:
        return None
    key = "dfanalyzer:" + (getattr(trace, "trace_dir", "") or "")
    spec = TaskSpec(pipeline_id="dfanalyzer", lane=Lane.NORMAL, dedup_key=key, cache=True)
    return await _run_task(app, spec)


def _themed_figure(x_axis_type: str = "linear") -> figure:
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
    p.background_fill_color = PLOT_BG
    p.border_fill_color = PANEL_BG
    p.outline_line_color = HAIR
    p.grid.grid_line_color = GRID
    p.axis.axis_line_color = DIVIDER
    p.axis.major_tick_line_color = DIVIDER
    p.axis.minor_tick_line_color = None
    p.axis.major_label_text_color = MUTED
    p.axis.major_label_text_font = FONT
    p.axis.major_label_text_font_size = "10px"
    p.axis.axis_label_text_font_size = "11px"
    p.axis.axis_label_standoff = 3
    return p


def _bandwidth(app: Any) -> tuple[pn.viewable.Viewable, Callable[[Any], Any]]:
    src = ColumnDataSource({"x": [], "read": [], "write": []})
    p = _themed_figure()
    p.line("x", "read", source=src, line_color=READ, line_width=2, legend_label="read")
    p.line("x", "write", source=src, line_color=WRITE, line_width=2, legend_label="write")
    p.legend.location = "top_left"
    p.legend.background_fill_color = PANEL_BG
    p.legend.border_line_color = DIVIDER
    p.legend.label_text_color = MUTED
    p.legend.label_text_font = FONT
    p.xaxis.axis_label = "seconds"
    p.xaxis.axis_label_text_color = MUTED
    p.xaxis.axis_label_text_font = FONT
    card = _wrap("I/O bandwidth (GB/s)", pn.pane.Bokeh(p, sizing_mode="stretch_both"))

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
            card.loading = False

        doc.add_next_tick_callback(apply)

    return card, fill


def _short_proc(name: str) -> str:
    parts = str(name).split("#")
    return f"proc {parts[2]}" if len(parts) > 2 else str(name)


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


def _rows_busiest(df: Any) -> list[tuple[str, float, str]]:
    if "data_size" not in df.columns:
        return []
    top = df.nlargest(12, "data_size")
    return [
        (_short_proc(r["proc_name"]), float(r["data_size"]), _fmt_bytes(r["data_size"]))
        for _, r in top.iterrows()
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


def _rows_bw_by_host(df: Any) -> list[tuple[str, float, str]]:
    if "proc_name" not in df.columns or "data_size" not in df.columns:
        return []
    tmp = df[["proc_name", "data_size", "data_time"]].copy()
    tmp["host"] = tmp["proc_name"].astype(str).str.split("#").str[1]
    g = tmp.groupby("host").agg(size=("data_size", "sum"), time=("data_time", "sum"))
    rows = []
    for host, r in g.iterrows():
        bw = float(r["size"]) / float(r["time"]) if float(r["time"]) > 0 else 0.0
        rows.append((str(host), bw, f"{_fmt_bytes(bw)}/s"))
    return sorted(rows, key=lambda x: -x[1])[:12]


_FULL_TRACE = '<div class="pcard-note">full trace (not filtered)</div>'


# op_stats bar card; responds to the window filter.
def _opstat_bar_card(
    title: str, rows: Callable[[dict], list[tuple[str, float, str]]]
) -> Callable[[Any], tuple[pn.pane.HTML, Callable[[Any], Any]]]:
    def builder(app: Any) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
        card = _html_card(title, "loading...")

        async def fill(doc: Any) -> None:
            try:
                res = await _compute(app, doc, "op_stats")
                inner = _bars(rows(res.data)) if res else '<div class="pcard-load">no trace</div>'
            except Exception as exc:
                inner = f'<div class="pcard-err">{exc}</div>'

            def apply() -> None:
                card.object = _card_html(title, inner)
                card.loading = False

            doc.add_next_tick_callback(apply)

        return card, fill

    return builder


# Whole-trace bar card from dfanalyzer; main_view stays on disk as parquet,
# read per fill so no DataFrame is held.
def _dfa_bar_card(
    title: str, rows: Callable[[Any], list[tuple[str, float, str]]]
) -> Callable[[Any], tuple[pn.pane.HTML, Callable[[Any], Any]]]:
    def builder(app: Any) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
        card = _html_card(title, "analyzing trace...")

        async def fill(doc: Any) -> None:
            try:
                res = await _dfa(app)
                path = (res.data or {}).get("main_view_path") if res else None
                if not path or not os.path.exists(path):
                    inner = '<div class="pcard-load">dfanalyzer not available</div>'
                else:
                    import pandas as pd

                    df = await asyncio.to_thread(pd.read_parquet, path)
                    inner = _bars(rows(df)) + _FULL_TRACE
            except Exception as exc:
                inner = f'<div class="pcard-err">{exc}</div>'

            def apply() -> None:
                card.object = _card_html(title, inner)
                card.loading = False

            doc.add_next_tick_callback(apply)

        return card, fill

    return builder


def _latency(app: Any) -> tuple[pn.viewable.Viewable, Callable[[Any], Any]]:
    src = ColumnDataSource({"x": [], "count": []})
    p = _themed_figure(x_axis_type="log")
    p.varea(x="x", y1=0, y2="count", source=src, fill_color=READ, fill_alpha=0.35)
    p.line("x", "count", source=src, line_color=READ, line_width=2)
    p.xaxis.axis_label = "duration (us)"
    p.xaxis.axis_label_text_color = MUTED
    p.xaxis.axis_label_text_font = FONT
    card = _wrap("Operation latency", pn.pane.Bokeh(p, sizing_mode="stretch_both"))

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
            card.loading = False

        doc.add_next_tick_callback(apply)

    return card, fill


def _xfer_hist(app: Any) -> tuple[pn.viewable.Viewable, Callable[[Any], Any]]:
    src = ColumnDataSource({"x": [], "count": []})
    p = _themed_figure(x_axis_type="log")
    p.varea(x="x", y1=0, y2="count", source=src, fill_color=WRITE, fill_alpha=0.35)
    p.line("x", "count", source=src, line_color=WRITE, line_width=2)
    p.xaxis.axis_label = "bytes"
    p.xaxis.axis_label_text_color = MUTED
    p.xaxis.axis_label_text_font = FONT
    card = _wrap("Transfer sizes", pn.pane.Bokeh(p, sizing_mode="stretch_both"))

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
            card.loading = False

        doc.add_next_tick_callback(apply)

    return card, fill


def _access_pattern(app: Any) -> tuple[pn.pane.HTML, Callable[[Any], Any]]:
    title = "Access pattern"
    card = _html_card(title, "analyzing trace...")

    async def fill(doc: Any) -> None:
        try:
            res = await _compute(app, doc, "access_pattern")
            if res is None:
                inner = '<div class="pcard-load">no trace</div>'
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
_BUILDERS: dict[str, Callable[[Any], tuple[pn.viewable.Viewable, Callable[[Any], Any]]]] = {
    "io_summary": _io_by_host,
    "bandwidth": _bandwidth,
    "latency": _latency,
    "xfer_hist": _xfer_hist,
    "access_pattern": _access_pattern,
    "op_time": _opstat_bar_card("I/O time by operation", _rows_op_time),
    "op_counts": _opstat_bar_card("Operation counts", _rows_op_counts),
    "read_write": _opstat_bar_card("Read vs write (bytes)", _rows_read_write),
    "avg_xfer": _opstat_bar_card("Avg transfer size", _rows_avg_xfer),
    "data_meta": _opstat_bar_card("Data vs metadata time", _rows_data_meta),
    "bw_by_host": _dfa_bar_card("Bandwidth by host", _rows_bw_by_host),
    "busiest": _dfa_bar_card("Busiest processes (I/O bytes)", _rows_busiest),
}


def card_ids() -> list[str]:
    return list(_BUILDERS)


def build_cards_app(app: Any) -> Application:
    def modify_doc(doc: Any) -> None:
        jobs: list[asyncio.Future] = []
        for cid, builder in _BUILDERS.items():
            view, fill = builder(app)
            view.loading = True  # spinner overlay until fill() lands
            root = view.get_root(doc)
            root.name = cid
            if root not in doc.roots:
                doc.add_root(root)
            jobs.append(asyncio.ensure_future(fill(doc)))

        def _cleanup(_ctx: Any) -> None:
            for j in jobs:
                j.cancel()

        doc.on_session_destroyed(_cleanup)

    return Application(FunctionHandler(modify_doc))
