"""Card base classes and the HTML they render.

One template drives every card: `body(doc)` fetches a payload, `paint(payload)`
puts it on screen, and `paint_error` decides what a failure looks like. A card
subclasses `HtmlCard` (inner markup) or `CanvasCard` (a Bokeh source), so a new
card is a title plus one fetch method.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Optional, cast

import panel as pn
from bokeh.document import Document
from bokeh.model import Model
from bokeh.models import ColumnDataSource
from bokeh.plotting import figure as Figure
from starlette.applications import Starlette

from ..core.theme import FONT, V_ACCENT, V_HAIR, V_INK, V_MUTED, V_PANEL, V_PLOT

log = logging.getLogger(__name__)

REFRESH_S = 10.0

WAITING = "waiting for the first trace records"
EMPTY = "no rows in this window"

FULL_TRACE_NOTE = '<div class="pcard-note">full trace (not filtered)</div>'

# Inlined as a scoped <style> inside each card's HTML pane; Panel isolates a
# component's stylesheets to its own shadow root, so a shared sheet on the outer
# layout would not reach the pane content.
CARD_CSS = f"""
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
"""


def busy(text: str = WAITING) -> str:
    return f'<div class="pcard-busy"><span class="pcard-dot"></span>{text}</div>'


def err(exc: object) -> str:
    return f'<div class="pcard-err">{exc}</div>'


def card_html(title: str, inner: str) -> str:
    return (
        f"<style>{CARD_CSS}</style>"
        f'<div class="pcard"><div class="pcard-head">{title}</div>'
        f'<div class="pcard-body">{inner}</div></div>'
    )


# rows: (name, magnitude, label); magnitude drives bar width, label is shown.
def bars(rows: list[tuple[str, float, str]]) -> str:
    if not rows:
        return busy(EMPTY)
    mx = max((v for _, v, _ in rows), default=1) or 1

    def _row(name: str, v: float, label: str) -> str:
        w = max(2, v / mx * 100)
        bar = f'<span class="cbar-fill" style="width:{w:.1f}%"></span>'
        return (
            f'<div class="cbar-row"><span class="cbar-name" title="{name}">{name}</span>'
            f'<span class="cbar-track">{bar}</span>'
            f'<span class="cbar-val">{label}</span></div>'
        )

    return f'<div class="cbars">{"".join(_row(*r) for r in rows)}</div>'


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
        margin=0,
        sizing_mode="stretch_width",
    )


def wrap(title: str, body: pn.viewable.Viewable) -> tuple[pn.Column, pn.pane.HTML]:
    """The card column plus the status it shows in the head until data lands.

    The status sits in the header row: inside the column it stole height from the
    plot, which then drew into a shrunken box.
    """
    status = pn.pane.HTML(
        busy(WAITING), margin=(0, 0, 0, 10), align="end", sizing_mode="stretch_width"
    )
    column = pn.Column(
        pn.Row(_head(title), status, sizing_mode="stretch_width", margin=(0, 0, 10, 0)),
        body,
        stylesheets=[_WRAP_CSS],
        sizing_mode="stretch_both",
        margin=0,
    )
    return column, status


class Card(pn.viewable.Viewer):
    """One overview card: a named document root with a fetch-paint cycle.

    `body` runs off the paint, `paint` runs on the document's thread, and a
    failure goes to `paint_error` instead of killing the refresh loop.
    """

    id: str = ""
    title: str = ""

    def __init__(self, app: Starlette, theme: str) -> None:
        self.app = app
        self.theme = theme
        self.view = self.build()

    def build(self) -> pn.viewable.Viewable:
        raise NotImplementedError

    def __panel__(self) -> pn.viewable.Viewable:
        return self.view

    def root(self, doc: Document) -> Model:
        """The document root the SPA mounts into its grid cell."""
        return self.view.get_root(doc)

    async def body(self, doc: Document) -> object:
        """Fetch what the card shows. None means no data yet: keep the placeholder."""
        raise NotImplementedError

    def paint(self, payload: object) -> None:
        raise NotImplementedError

    def paint_error(self, exc: Exception) -> None:
        raise exc

    def after(self, doc: Document, fn: Callable[[], None]) -> None:
        doc.add_next_tick_callback(fn)

    async def fill(self, doc: Document) -> None:
        try:
            payload = await self.body(doc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # surface the failure in the card, not the log only
            # bind before the closure: `exc` is cleared when the except block ends
            failure = exc
            self.after(doc, lambda: self.paint_error(failure))
            return
        if payload is not None:
            self.after(doc, lambda: self.paint(payload))


class HtmlCard(Card):
    """A card whose content is markup."""

    busy = WAITING

    def build(self) -> pn.pane.HTML:
        return pn.pane.HTML(
            card_html(self.title, busy(self.busy)), sizing_mode="stretch_both", margin=0
        )

    def paint(self, payload: object) -> None:
        html = cast("pn.pane.HTML", self.view)
        html.object = card_html(self.title, str(payload))

    def paint_error(self, exc: Exception) -> None:
        self.paint(err(exc))


class CanvasCard(Card):
    """A card whose content is a Bokeh figure fed from one ColumnDataSource."""

    x_axis_type = "linear"

    def build(self) -> pn.viewable.Viewable:
        self.source = ColumnDataSource(self.empty())
        self.figure = self.chart(self.source)
        self.view, self.status = wrap(
            self.title, pn.pane.Bokeh(self.figure, sizing_mode="stretch_both")
        )
        return self.view

    def empty(self) -> dict[str, object]:
        return {}

    def chart(self, source: ColumnDataSource) -> Figure:
        raise NotImplementedError

    def paint(self, payload: object) -> None:
        self.source.data.update(cast("dict[str, list[object]]", payload))
        self.status.visible = False


def version(app: Starlette) -> Optional[int]:
    """The watched tree's change counter, or None when nothing can change."""
    registry = getattr(app.state, "registry", None)
    return registry.seq if registry is not None else None


async def live(app: Starlette, card: Card, doc: Document) -> None:
    """Paint a card, then repaint it when the watched tree changes.

    One sequential loop per card, so a slow fill never stacks up behind itself
    and an idle tree costs one integer compare per REFRESH_S.
    """
    seen = version(app)
    while True:
        try:
            await card.fill(doc)
        except asyncio.CancelledError:
            raise
        except Exception:  # a dead loop would freeze the card silently
            log.exception("card %s failed", card.id)
        if seen is None:
            return
        while True:
            await asyncio.sleep(REFRESH_S)
            now = version(app)
            if now != seen:
                seen = now
                break
