"""Mount the cards as one Bokeh application: one root per card, one websocket."""

from __future__ import annotations

import asyncio
from concurrent.futures import Future

from bokeh.application import Application
from bokeh.application.handlers.function import FunctionHandler
from bokeh.document import Document
from fastapi import FastAPI

from ..analysis.docloop import spawn
from ..core.theme import bokeh_theme
from .base import live
from .builders import CARDS
from .session import theme_of

CARDS_PATH = "/cards"


def card_ids() -> list[str]:
    return [cls.id for cls in CARDS]


def build_cards_app(app: FastAPI) -> Application:
    def modify_doc(doc: Document) -> None:
        theme = theme_of(doc)
        doc.theme = bokeh_theme(theme)
        jobs: list[Future[None] | asyncio.Future[None]] = []
        for cls in CARDS:
            card = cls(app, theme)
            root = card.root(doc)
            root.name = card.id
            if root not in doc.roots:
                doc.add_root(root)
            jobs.append(spawn(app, live(app, card, doc)))

        def _cleanup(_ctx: object) -> None:
            for j in jobs:
                j.cancel()

        doc.on_session_destroyed(_cleanup)

    return Application(FunctionHandler(modify_doc))
