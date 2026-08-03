"""Render a DashboardSpec into a Panel layout."""

from __future__ import annotations

import panel as pn

from ..analysis.panel_app import FONT, GRID, INK, MUTED, PANEL_BG, PLOT_BG, WRITE
from .model import DashboardContext, DashboardSpec, GridPos, PanelSpec
from .registry import build_panel

_ICON_OVERVIEW = (
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">'
    '<rect x="1.5" y="1.5" width="6" height="6" rx="1"/>'
    '<rect x="8.5" y="1.5" width="6" height="4" rx="1"/>'
    '<rect x="8.5" y="6.5" width="6" height="8" rx="1"/>'
    '<rect x="1.5" y="8.5" width="6" height="6" rx="1"/></svg>'
)
_ICON_TRACE = (
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
    'stroke-width="1.6"><path d="M3 5h18M3 12h18M3 19h18"/></svg>'
)
_ICON_ANALYSIS = (
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
    'stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'
)


def _card(spec: PanelSpec, body: pn.viewable.Viewable) -> pn.viewable.Viewable:
    flex = {"flex": f"{spec.grid.w} 1 0", "min-width": "0"}
    if not spec.title:
        return pn.Column(body, sizing_mode="stretch_width", styles=flex, margin=0)
    head = pn.pane.HTML(
        f'<div style="color:{MUTED};font:600 11px {FONT};text-transform:uppercase;'
        f'letter-spacing:1px;padding:8px 12px 4px">{spec.title}</div>',
        margin=0,
        sizing_mode="stretch_width",
    )
    return pn.Column(
        head,
        body,
        sizing_mode="stretch_width",
        styles={
            "background": PLOT_BG,
            "border": f"1px solid {GRID}",
            "border-radius": "3px",
            **flex,
        },
        margin=0,
    )


def _rail() -> pn.viewable.Viewable:
    css = f"""<style>
    .drail {{ flex:0 0 156px; display:flex; flex-direction:column; gap:10px; padding:12px 10px;
      background:linear-gradient(180deg,{PANEL_BG},{PLOT_BG}); border-right:1px solid {GRID};
      min-height:100vh; box-sizing:border-box; font-family:{FONT}; }}
    .drail-top {{ display:flex; align-items:center; gap:8px; padding:2px 4px 8px;
      border-bottom:1px solid {GRID}; }}
    .drail-mark {{ width:10px; height:10px; background:{WRITE};
      box-shadow:0 0 10px rgba(230,161,60,.45); }}
    .drail-brand {{ font-weight:700; font-size:14px; letter-spacing:.02em; color:{INK}; }}
    .drail-items {{ display:flex; flex-direction:column; gap:2px; }}
    .drail-item {{ display:flex; align-items:center; gap:10px; padding:8px 10px; color:{MUTED};
      text-decoration:none; font-size:13px; }}
    .drail-item:hover {{ background:{GRID}; color:{INK}; }}
    .drail-item.active {{ background:rgba(230,161,60,.16); color:{INK}; }}
    .drail-item .ic {{ flex:0 0 16px; display:inline-flex; color:{MUTED}; }}
    .drail-item:hover .ic {{ color:{INK}; }}
    .drail-item.active .ic {{ color:{WRITE}; }}
    </style>"""

    def item(label: str, href: str, icon: str, active: bool = False) -> str:
        cls = "drail-item active" if active else "drail-item"
        return (
            f'<a class="{cls}" href="{href}"><span class="ic">{icon}</span><span>{label}</span></a>'
        )

    body = (
        '<div class="drail"><div class="drail-top"><span class="drail-mark"></span>'
        '<span class="drail-brand">DFDashboard</span></div><div class="drail-items">'
        + item("Overview", "/", _ICON_OVERVIEW, active=True)
        + item("Trace", "/trace", _ICON_TRACE)
        + item("Analysis", "/analysis", _ICON_ANALYSIS)
        + "</div></div>"
    )
    return pn.pane.HTML(css + body, margin=0, sizing_mode="fixed", width=156)


def render_dashboard(spec: DashboardSpec, ctx: DashboardContext) -> pn.viewable.Viewable:
    title = pn.pane.HTML(
        f'<div style="color:{INK};font:600 15px {FONT};text-transform:uppercase;'
        f'letter-spacing:1.5px;padding:2px 2px 12px">{spec.title}</div>',
        margin=0,
        sizing_mode="stretch_width",
    )
    rows: dict[int, list[PanelSpec]] = {}
    for p in spec.panels:
        rows.setdefault(p.grid.y, []).append(p)

    board = pn.Column(title, sizing_mode="stretch_width")
    for y in sorted(rows):
        panels = sorted(rows[y], key=lambda p: p.grid.x)
        row = pn.Row(sizing_mode="stretch_width", styles={"gap": "12px"}, margin=0)
        for p in panels:
            row.append(_card(p, build_panel(p, ctx)))
        board.append(row)

    main = pn.Column(
        board,
        sizing_mode="stretch_width",
        styles={"background": PLOT_BG, "padding": "16px 20px", "min-height": "100vh"},
        margin=0,
    )
    return pn.Row(
        _rail(), main, sizing_mode="stretch_width", styles={"background": PLOT_BG}, margin=0
    )


def default_overview() -> DashboardSpec:
    return DashboardSpec(
        title="Overview",
        panels=[
            PanelSpec(id="stats", type="stat", grid=GridPos(x=0, y=0, w=12, h=2)),
            PanelSpec(
                id="bw", type="bandwidth", title="I/O bandwidth", grid=GridPos(x=0, y=1, w=12, h=4)
            ),
            PanelSpec(
                id="tl", type="timeline", title="Timeline", grid=GridPos(x=0, y=2, w=12, h=9)
            ),
        ],
    )
