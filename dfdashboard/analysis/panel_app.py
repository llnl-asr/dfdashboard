"""Panel plots mounted on FastAPI (no Tornado), embeddable in the Solid app with no iframe.

mount_panel serves the doc + websocket via BokehFastAPI and adds a `/panel/autoload.js`
route (ported from Bokeh's AutoloadJsHandler) so server_document can inject a live
session into a plain <div>. embed_script() returns that script.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import panel as pn
from bokeh.core.templates import AUTOLOAD_JS
from bokeh.embed.bundle import Script, bundle_for_objs_and_resources
from bokeh.embed.elements import script_for_render_items
from bokeh.embed.server import server_document
from bokeh.embed.util import RenderItem
from bokeh.models import ColumnDataSource, DataRange1d
from bokeh.plotting import figure
from bokeh.util.token import generate_jwt_token, generate_session_id
from bokeh_fastapi import BokehFastAPI
from fastapi import FastAPI, Request, Response
from panel.io.application import build_applications
from tornado.httputil import HTTPHeaders, HTTPServerRequest
from tornado.ioloop import IOLoop

from .cards import CARDS_PATH, build_cards_app
from .docloop import spawn

pn.extension("tabulator", inline=True)

# Repoint Panel's design CSS + spinner from cdn.holoviz.org to a locally-served
# copy of its bundled dist/ (air-gapped clusters). Server resource mode would
# break the multi-session cards app (shared ImportedStyleSheet models), so we
# stay in cdn mode and only rewrite the frozen CDN_DIST strings.
import sys as _sys  # noqa: E402

import panel.io.resources as _pnres  # noqa: E402

PANEL_DIST_DIR = Path(pn.__file__).parent / "dist"
PANEL_DIST_MOUNT = f"/panel-dist/{pn.__version__}/dist/"


def _localize_panel_cdn() -> None:
    base = _pnres.CDN_DIST

    def repl(val: Any) -> Any:
        if isinstance(val, str):
            return val.replace(base, PANEL_DIST_MOUNT) if base in val else val
        if isinstance(val, list):
            return [repl(v) for v in val]
        if isinstance(val, dict):
            return {k: repl(v) for k, v in val.items()}
        return val

    for mod in list(_sys.modules.values()):
        if not getattr(mod, "__name__", "").startswith("panel"):
            continue
        for key, val in list(vars(mod).items()):
            if isinstance(val, str):
                if base in val:
                    setattr(mod, key, repl(val))
            elif isinstance(val, type):
                for ckey, cval in list(vars(val).items()):
                    if isinstance(cval, (str, list, dict)):
                        new = repl(cval)
                        if new != cval:
                            setattr(val, ckey, new)

    # Pass local URLs through verbatim like http ones; the file-path branch
    # would build a shared ImportedStyleSheet and break the per-session cards.
    _orig_resolve = _pnres.resolve_stylesheet

    def _resolve_stylesheet(cls: Any, stylesheet: str, attribute: str | None = None) -> Any:
        s = os.fspath(stylesheet)
        if isinstance(s, str) and s.startswith(PANEL_DIST_MOUNT):
            return s
        return _orig_resolve(cls, stylesheet, attribute)

    _pnres.resolve_stylesheet = _resolve_stylesheet  # ty: ignore[invalid-assignment]


_localize_panel_cdn()

# DFDashboard palette (web/src/timeline/theme.ts)
PLOT_BG, PANEL_BG, GRID, DIVIDER = "#0a0b0a", "#0c0e0b", "#16180f", "#1f2119"
INK, MUTED, READ, WRITE = "#e6e2ce", "#8a927c", "#4bb0c4", "#e6a13c"
FONT = "'SFMono-Regular', ui-monospace, monospace"

LANE_ALT, HOVER = "#0d0f0c", "#12140f"
_APP_PATH = "/panel"
_DASH_PATH = "/dashboard"

# Tabulator + MultiChoice restyled to the DFDashboard palette; the built-in themes don't match.
_TABLE_CSS = f"""
.tabulator, .tabulator-tableholder, .tabulator-table {{ background:{PLOT_BG} !important;
  border:none; font-family:{FONT}; font-size:12px; color:{INK}; }}
.tabulator .tabulator-header {{ background:{PLOT_BG} !important;
  border-bottom:1px solid {GRID}; color:{MUTED}; }}
.tabulator .tabulator-header .tabulator-col, .tabulator .tabulator-col {{
  background:{PLOT_BG} !important; border-right:none !important; border-left:none !important; }}
.tabulator .tabulator-col-title {{ color:{MUTED} !important; font-weight:500;
  text-transform:uppercase; letter-spacing:1px; font-size:11px; }}
.tabulator-row, .tabulator-row.tabulator-row-even, .tabulator-row.tabulator-row-odd {{
  background:{PLOT_BG} !important; border-bottom:1px solid {GRID}; }}
.tabulator-row.tabulator-selectable:hover, .tabulator-row:hover {{
  background:{HOVER} !important; }}
.tabulator-row .tabulator-cell {{ border:none !important; color:{INK} !important;
  padding:6px 12px; }}
.tabulator .tabulator-footer {{ background:{PLOT_BG} !important; border-top:1px solid {DIVIDER};
  color:{MUTED}; padding:6px 4px; }}
.tabulator .tabulator-footer .tabulator-paginator {{ color:{MUTED}; font-family:{FONT};
  font-size:11px; }}
.tabulator .tabulator-footer .tabulator-page {{ background:transparent !important;
  color:{MUTED} !important; border:none !important; border-radius:3px; margin:0 1px;
  padding:3px 9px; font-family:{FONT}; font-size:11px; }}
.tabulator .tabulator-footer .tabulator-page:not(.active):hover {{ background:{HOVER} !important;
  color:{INK} !important; }}
.tabulator .tabulator-footer .tabulator-page.active {{ background:{HOVER} !important;
  color:{WRITE} !important; font-weight:700; }}
.tabulator .tabulator-footer .tabulator-page[disabled] {{ opacity:.35; }}
.tabulator .tabulator-col-sorter {{ color:{MUTED}; }}
.tabulator .tabulator-col[aria-sort='ascending'] .tabulator-col-sorter,
.tabulator .tabulator-col[aria-sort='descending'] .tabulator-col-sorter {{ color:{WRITE}; }}
.tabulator .tabulator-header-filter input, .tabulator .tabulator-header-filter select {{
  background:{PANEL_BG} !important; color:{INK} !important; border:1px solid {DIVIDER};
  border-radius:2px; font-family:{FONT}; font-size:11px; }}
.tabulator .tabulator-frozen {{ background:{PLOT_BG} !important;
  border-right:1px solid {GRID}; }}
"""
_PICKER_CSS = f"""
.choices__inner {{ background:{PLOT_BG} !important; border:1px solid {GRID} !important;
  border-radius:3px; font-family:{FONT}; }}
.choices__list--multiple .choices__item,
.choices__list--multiple .choices__item--selectable {{ background:{HOVER} !important;
  border:none !important; color:{INK} !important; border-radius:3px;
  font-size:11px; font-family:{FONT}; }}
.choices__list--multiple .choices__item .choices__button {{ border-left:none !important;
  margin-left:6px; opacity:.4; filter:none; }}
.choices__list--dropdown, .choices__list[aria-expanded] {{ background:{PANEL_BG} !important;
  border:1px solid {DIVIDER} !important; color:{INK}; font-family:{FONT}; }}
.choices__list--dropdown .choices__item {{ color:{INK}; }}
.choices__item--choice.is-highlighted {{ background:{HOVER} !important; color:{INK}; }}
.choices__input {{ background:{PLOT_BG} !important; color:{INK} !important; }}
"""
_QUERY_CSS = f"""
input {{ background:{PLOT_BG} !important; color:{INK} !important; border:1px solid {GRID};
  border-radius:3px; font-family:{FONT}; font-size:12px; padding:6px 10px; }}
input::placeholder {{ color:{MUTED}; }}
input:focus {{ border-color:{WRITE}; outline:none; }}
"""
_CARD_CSS = f"""
:host, .card {{ background:{PLOT_BG} !important; border:1px solid {GRID} !important;
  border-radius:3px !important; box-shadow:none !important; }}
.card-header, .accordion-header {{ background:{PLOT_BG} !important; border:none !important;
  color:{MUTED} !important; font-family:{FONT}; font-size:11px; font-weight:600;
  text-transform:uppercase; letter-spacing:.5px; }}
.card-header:hover {{ background:{HOVER} !important; }}
.card-title, .card-title *, .card-button, .accordion-header button {{ color:{MUTED} !important;
  font-family:{FONT} !important; }}
.card-header-row {{ background:transparent !important; }}
"""


def _rescale_units(df: Any, cols: list[str], per_sec: bool) -> dict[str, str]:
    """Scale each byte(-rate) column to one unit from its max; return the unit
    titles. Column names stay raw so the query box keeps working on them."""
    prefixes = ["", "K", "M", "G", "T", "P"]
    titles: dict[str, str] = {}
    for c in cols:
        col = df[c]
        if not col.notna().any():
            continue
        m = float(col.abs().max())
        k = 0
        while m >= 1000.0 and k < len(prefixes) - 1:
            m /= 1000.0
            k += 1
        if k:
            df[c] = (col / (1000.0**k)).round(3)
        titles[c] = f"{c} ({prefixes[k]}B/s)" if per_sec else f"{c} ({prefixes[k]}B)"
    return titles


def theme_figure(p: figure) -> None:
    p.background_fill_color = PLOT_BG
    p.border_fill_color = PANEL_BG
    p.outline_line_color = DIVIDER
    p.grid.grid_line_color = GRID
    p.axis.axis_line_color = DIVIDER
    p.axis.major_tick_line_color = DIVIDER
    p.axis.minor_tick_line_color = None
    p.axis.major_label_text_color = MUTED
    p.axis.major_label_text_font = FONT
    p.title.text_color = INK  # ty: ignore[invalid-assignment]
    p.title.text_font = FONT  # ty: ignore[invalid-assignment]


def _session_task_id() -> str:
    args = pn.state.session_args or {}
    val = args.get("task", [b""])
    raw = val[0] if val else b""
    return raw.decode() if isinstance(raw, bytes) else str(raw)


_TERMINAL = {"done", "failed", "cancelled", "interrupted"}
_DFA_DEFAULT_METRICS = [
    "bw",
    "intensity",
    "count",
    "data_bw",
    "data_size",
    "data_time",
    "metadata_time",
    "metadata_count",
]


def _msg(text: str) -> Any:
    return pn.pane.HTML(
        f'<div style="margin:40px auto;text-align:center;color:{MUTED};font:14px {FONT}">'
        f"{text}</div>",
        sizing_mode="stretch_width",
    )


def _tile(label: str, value: str) -> Any:
    return pn.pane.HTML(
        f'<div style="border:1px solid {DIVIDER};background:{PANEL_BG};border-radius:4px;'
        f'padding:8px 14px;margin:0 8px 8px 0">'
        f'<div style="color:{MUTED};font:11px {FONT};text-transform:uppercase;letter-spacing:1px">'
        f"{label}</div>"
        f'<div style="color:{INK};font:18px {FONT};font-weight:600">{value}</div></div>',
        sizing_mode="fixed",
    )


def _bandwidth_view(app: FastAPI, task_id: str, events: Any, doc: Any) -> Any:
    src = ColumnDataSource({"x": [], "read": [], "write": []})
    p = figure(
        height=380,
        sizing_mode="stretch_width",
        title="I/O bandwidth (GB/s)",
        toolbar_location="right",
        tools="pan,wheel_zoom,reset",
        output_backend="webgl",
        y_range=DataRange1d(start=0),
    )
    theme_figure(p)
    p.line("x", "read", source=src, line_color=READ, line_width=2, legend_label="read")
    p.line("x", "write", source=src, line_color=WRITE, line_width=2, legend_label="write")
    p.legend.location = "top_left"
    p.legend.background_fill_color = PANEL_BG
    p.legend.border_line_color = DIVIDER
    p.legend.label_text_color = MUTED
    p.legend.label_text_font = FONT

    if task_id and events is not None and doc is not None:

        async def pump():
            async for _topic, payload in events.subscribe(f"task.{task_id}.partial"):
                doc.add_next_tick_callback(
                    lambda p=payload: src.stream(
                        {"x": [p["x"]], "read": [p["read"]], "write": [p["write"]]}, rollover=5000
                    )
                )

        job = spawn(app, pump())
        pn.state.on_session_destroyed(lambda _c: job.cancel())

    return pn.pane.Bokeh(p, sizing_mode="stretch_width")


def _render_dfanalyzer(data: dict) -> Any:
    import pandas as pd

    s = data.get("raw_stats") or {}

    def num(v: Any, unit: str = "") -> str:
        if v is None:
            return "-"
        return f"{float(v):.1f}{unit}" if unit else f"{int(v):,}"

    tiles = pn.FlexBox(
        _tile("Job time", num(s.get("job_time"), "s")),
        _tile("Events", num(s.get("total_event_count"))),
        _tile("Files", num(s.get("unique_file_count"))),
        _tile("Hosts", num(s.get("unique_host_count"))),
        _tile("Processes", num(s.get("unique_process_count"))),
        sizing_mode="stretch_width",
    )
    parts: list[Any] = [tiles]

    path = data.get("main_view_path")
    if path and os.path.exists(path):
        df = pd.read_parquet(path)
        cols = [str(c) for c in df.columns]
        titles = _rescale_units(df, [c for c in cols if "bw" in c.lower()], per_sec=True)
        titles.update(_rescale_units(df, [c for c in cols if "size" in c.lower()], per_sec=False))
        ids = [c for c in cols[:2]]
        default = list(dict.fromkeys(ids + [m for m in _DFA_DEFAULT_METRICS if m in cols]))
        default = default or cols[:12]
        table = pn.widgets.Tabulator(
            df,
            disabled=True,
            pagination="local",
            page_size=15,
            theme="simple",
            show_index=False,
            layout="fit_data_table",
            frozen_columns=ids,
            titles=titles,
            sizing_mode="stretch_width",
            height=560,
            hidden_columns=[c for c in cols if c not in default],
            stylesheets=[_TABLE_CSS],
        )

        query = pn.widgets.TextInput(
            name="",
            placeholder="filter rows, e.g.  bw > 1e9 and proc_name.str.contains('train')",
            sizing_mode="stretch_width",
            stylesheets=[_QUERY_CSS],
        )
        err = pn.pane.HTML("", sizing_mode="stretch_width", styles={"color": WRITE})

        def apply_query(e: Any) -> None:
            expr = (e.new or "").strip()
            if not expr:
                table.value, err.object = df, ""
                return
            try:
                table.value = df.query(expr, engine="python")
                err.object = ""
            except Exception as ex:
                err.object = f"query error: {ex}"

        query.param.watch(apply_query, "value")

        picker = pn.widgets.MultiChoice(
            name="",
            options=cols,
            value=default,
            sizing_mode="stretch_width",
            stylesheets=[_PICKER_CSS],
        )
        picker.param.watch(
            lambda e: setattr(table, "hidden_columns", [c for c in cols if c not in e.new]), "value"
        )
        cols_card = pn.Card(
            picker,
            title="Columns",
            collapsed=True,
            sizing_mode="stretch_width",
            stylesheets=[_CARD_CSS],
        )
        parts += [query, err, cols_card, table]
    return pn.Column(*parts, sizing_mode="stretch_width")


def _render_result(pipeline: str, data: Any) -> Any:
    if pipeline == "dfanalyzer":
        return _render_dfanalyzer(data if isinstance(data, dict) else {})
    return pn.pane.JSON(data, theme="dark", depth=3, sizing_mode="stretch_width")


def _make_app(app: FastAPI):
    def make_app():
        task_id = _session_task_id()
        backend = getattr(app.state, "backend", None)
        events = getattr(app.state, "events", None)
        doc = pn.state.curdoc
        rec = backend.get(task_id) if (backend and task_id) else None

        if rec is not None and rec.spec.pipeline_id == "bandwidth_scan":
            return _bandwidth_view(app, task_id, events, doc)

        container = pn.Column(sizing_mode="stretch_width")
        if rec is None or backend is None:
            container.append(_msg("Run a pipeline to see its result."))
            return container

        def render() -> None:
            r = backend.get(task_id)
            if r is not None and r.result is not None:
                container[:] = [_render_result(r.spec.pipeline_id, r.result.data)]
            elif r is not None and r.error:
                container[:] = [_msg(f"Failed: {r.error}")]

        if rec.state.value in _TERMINAL:
            render()
        else:
            container.append(_msg("Running analysis..."))
            if events is not None and doc is not None:

                async def watch():
                    async for _topic, payload in events.subscribe("task"):
                        if payload.get("task_id") == task_id and payload.get("state") in _TERMINAL:
                            doc.add_next_tick_callback(render)
                            break

                job = spawn(app, watch())
                pn.state.on_session_destroyed(lambda _c: job.cancel())
        return container

    return make_app


def _make_dashboard_app(app: FastAPI):
    def make_app():
        # Lazy import: the dashboard package pulls this module's palette, so a
        # top-level import would be circular.
        from ..dashboard import DashboardContext, default_overview, render_dashboard

        trace = getattr(app.state, "trace", None)
        if trace is None:
            return pn.Column(_msg("No trace loaded."))
        return render_dashboard(default_overview(), DashboardContext(trace))

    return make_app


async def _new_session(server: BokehFastAPI, app_path: str, request: Request) -> Any:
    ctx = server._applications[app_path]
    session_id = generate_session_id(secret_key=server.secret_key, signed=server.sign_sessions)
    treq = HTTPServerRequest(
        method="GET", uri=str(request.url), headers=HTTPHeaders(dict(request.headers))
    )
    args: dict[str, list[bytes]] = {
        k: [v.encode()] for k, v in request.query_params.items() if not k.startswith("bokeh-")
    }
    payload: dict[str, Any] = {"headers": dict(request.headers), "cookies": {}, "arguments": args}
    payload.update(ctx.application.process_request(treq))
    token = generate_jwt_token(
        session_id,
        secret_key=server.secret_key,
        signed=server.sign_sessions,
        expiration=300,
        extra_payload=payload,
    )
    if ctx.io_loop is None:
        ctx._loop = IOLoop.current()  # ty: ignore[invalid-assignment]  bokeh types it as a plain loop
    return await ctx.create_session_if_needed(session_id, treq, token)


def _autoload_js(server: BokehFastAPI, request: Request, app_path: str, items: list) -> Response:
    element_id = request.query_params["bokeh-autoload-element"]
    absolute_url = request.query_params.get("bokeh-absolute-url")
    server_url = None
    if absolute_url:
        uri = urlparse(absolute_url)
        server_url = f"{uri.scheme}://{uri.netloc}"
    bundle = bundle_for_objs_and_resources(None, server.resources(server_url))
    script = script_for_render_items({}, items, app_path=app_path, absolute_url=absolute_url)
    bundle.add(Script(script))
    js = AUTOLOAD_JS.render(bundle=bundle, elementid=element_id)
    return Response(js, media_type="application/javascript")


def mount_panel(app: FastAPI) -> None:
    from fastapi.staticfiles import StaticFiles

    apps = build_applications({_APP_PATH: _make_app(app), _DASH_PATH: _make_dashboard_app(app)})
    apps[CARDS_PATH] = build_cards_app(app)  # raw multi-root Bokeh app
    server = BokehFastAPI(apps, app=app, websocket_origins=["*"])
    app.state.panel = server

    if PANEL_DIST_DIR.is_dir():
        app.mount(
            PANEL_DIST_MOUNT.rstrip("/"),
            StaticFiles(directory=PANEL_DIST_DIR),
            name="panel-dist",
        )

    @app.get(f"{_APP_PATH}/autoload.js")
    async def autoload(request: Request) -> Response:
        element_id = request.query_params["bokeh-autoload-element"]
        app_path = request.query_params.get("bokeh-app-path", _APP_PATH)
        session = await _new_session(server, _APP_PATH, request)
        items = [RenderItem(token=session.token, elementid=element_id, use_for_title=False)]  # ty: ignore[invalid-argument-type]
        return _autoload_js(server, request, app_path, items)

    # Cards share one session; each requested card's root renders into its own
    # `pcard-<id>` div, so the Solid overview can place them wherever it wants.
    # Build the roots map in document-root order (the client pairs roots to
    # elements positionally), mapping each root to its own name's element.
    @app.get(f"{CARDS_PATH}/autoload.js")
    async def cards_autoload(request: Request) -> Response:
        element_id = request.query_params["bokeh-autoload-element"]
        app_path = request.query_params.get("bokeh-app-path", CARDS_PATH)
        want = {c for c in request.query_params.get("cards", "").split(",") if c}
        session = await _new_session(server, CARDS_PATH, request)
        roots = {r: f"pcard-{r.name}" for r in session.document.roots if r.name in want}
        items = [
            RenderItem(token=session.token, roots=roots, use_for_title=False)  # ty: ignore[invalid-argument-type]
            if roots
            else RenderItem(token=session.token, elementid=element_id, use_for_title=False)  # ty: ignore[invalid-argument-type]
        ]
        return _autoload_js(server, request, app_path, items)


def embed_script(task: str = "") -> str:
    args = {"task": task} if task else None
    return server_document(_APP_PATH, relative_urls=True, arguments=args)


def cards_embed_script(
    cards: list[str], begin: str = "", end: str = "", query: str = "", theme: str = "dark"
) -> str:
    args = {"cards": ",".join(cards), "theme": theme}
    if begin:
        args["begin"] = begin
    if end:
        args["end"] = end
    if query:
        args["query"] = query
    return server_document(CARDS_PATH, relative_urls=True, arguments=args)
