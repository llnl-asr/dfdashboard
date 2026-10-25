"""The Bokeh card app must fill its roots from a worker thread.

Bokeh 3.10 initializes a new document in a worker thread, where no event loop
runs, so scheduling the card fills with asyncio.ensure_future() raises
"There is no current event loop". This pins the doc-loop scheduling.
"""

import asyncio
from types import SimpleNamespace

import pytest
from traces import posix, write_trace  # noqa: E402

pytest.importorskip("dftracer.utils")

from dftracer.dashboard.cards import app as cards_app  # noqa: E402
from dftracer.dashboard.cards import base as cards_base  # noqa: E402
from dftracer.dashboard.cards import builders as cards_builders  # noqa: E402
from dftracer.dashboard.cards import session as cards_session  # noqa: E402
from dftracer.dashboard.config import Settings  # noqa: E402
from dftracer.dashboard.server import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _write_trace(directory: str) -> str:
    return write_trace(directory, posix(6, ret=1024))


def test_cards_fill_from_the_document_worker_thread(tmp_path, monkeypatch):
    app = create_app(
        Settings(trace_paths=[_write_trace(str(tmp_path))], index_dir=str(tmp_path / "idx"))
    )

    scheduled = []
    real_spawn = cards_app.spawn

    def recording_spawn(app_: object, coro: object) -> object:
        fut = real_spawn(app_, coro)
        scheduled.append(fut)
        return fut

    monkeypatch.setattr(cards_app, "spawn", recording_spawn)

    with TestClient(app) as client:
        res = client.get(f"{cards_app.CARDS_PATH}/autoload.js?bokeh-autoload-element=x")
        assert res.status_code == 200
        assert scheduled, "no card fill was scheduled"
        # .result() on the scheduled future re-raises anything the fill raised.
        for fut in scheduled:
            fut.result(timeout=60)


class _Registry:
    """Stand-in for the watcher: a seq that moves and a current trace."""

    def __init__(self) -> None:
        self.seq = 1

    def trace(self) -> object:
        return object()


def _app_with(registry: object) -> object:
    return SimpleNamespace(state=SimpleNamespace(registry=registry, trace=None))


class _Fill:
    """Stand-in for a card: the live loop only needs an id and a fill."""

    id = "c"

    def __init__(self, fn) -> None:
        self.fn = fn

    async def fill(self, doc: object) -> None:
        await self.fn(doc)


async def test_live_card_repaints_only_when_the_tree_changes(monkeypatch):
    monkeypatch.setattr(cards_base, "REFRESH_S", 0.01)
    registry = _Registry()
    paints: list[int] = []

    async def fill(_doc: object) -> None:
        paints.append(registry.seq)

    task = asyncio.create_task(cards_base.live(_app_with(registry), _Fill(fill), None))
    await asyncio.sleep(0.1)
    assert paints == [1], "an unchanged tree must not repaint"

    registry.seq = 2
    await asyncio.sleep(0.1)
    assert paints == [1, 2], "a moved seq must repaint once"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_live_card_paints_once_without_a_watcher(monkeypatch):
    monkeypatch.setattr(cards_base, "REFRESH_S", 0.01)
    paints: list[int] = []

    async def fill(_doc: object) -> None:
        paints.append(len(paints))

    await asyncio.wait_for(cards_base.live(_app_with(None), _Fill(fill), None), timeout=5)
    assert paints == [0]


async def test_live_card_survives_a_failing_fill(monkeypatch):
    monkeypatch.setattr(cards_base, "REFRESH_S", 0.01)
    registry = _Registry()
    calls: list[int] = []

    async def fill(_doc: object) -> None:
        calls.append(registry.seq)
        if len(calls) == 1:
            raise RuntimeError("index is still being built")

    task = asyncio.create_task(cards_base.live(_app_with(registry), _Fill(fill), None))
    await asyncio.sleep(0.1)
    registry.seq = 2
    await asyncio.sleep(0.1)
    assert calls == [1, 2], "a failed paint must not kill the loop"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_io_by_host_asks_again_instead_of_reusing_a_cached_result(monkeypatch):
    specs: list[object] = []

    async def fake_run(_app: object, spec: object, *_a: object, **_k: object) -> object:
        specs.append(spec)
        return SimpleNamespace(data={"bytes_by_host": {"node1": 1}})

    monkeypatch.setattr(cards_session, "run_task", fake_run)
    app = SimpleNamespace(state=SimpleNamespace(trace=object(), registry=None))
    card = cards_builders.IoByHost(app, "dark")

    class Doc:
        def add_next_tick_callback(self, cb: object) -> None:
            cb()  # type: ignore[operator]

    await card.fill(Doc())
    await card.fill(Doc())
    assert len(specs) == 2, "a second fill must not be served from the result cache"
    assert getattr(specs[0], "cache") is False


def test_every_card_shows_the_same_busy_indicator():
    app = SimpleNamespace(state=SimpleNamespace(trace=None, registry=None))
    shown = {}
    for cls in cards_builders.CARDS:
        card = cls(app, "dark")
        shown[cls.id] = getattr(card, "status", card.view).object

    assert len(shown) == 12
    for cid, markup in shown.items():
        assert "pcard-busy" in markup, f"{cid} must show a spinner like the other cards"
    assert ".pcard-dot" in cards_base.CARD_CSS
    assert "pcard-spin" in cards_base.CARD_CSS


async def test_io_by_host_waits_instead_of_failing_without_a_trace(monkeypatch):
    calls: list[object] = []

    async def fake_run(_app: object, spec: object, *_a: object, **_k: object) -> object:
        calls.append(spec)
        raise AssertionError("the pipeline must not run without a trace")

    monkeypatch.setattr(cards_session, "run_task", fake_run)
    app = SimpleNamespace(state=SimpleNamespace(trace=None, registry=None))
    card = cards_builders.IoByHost(app, "dark")

    class Doc:
        def add_next_tick_callback(self, cb: object) -> None:
            cb()  # type: ignore[operator]

    await card.fill(Doc())
    assert calls == []
    markup = card.view.object  # ty: ignore[unresolved-attribute]
    assert cards_base.WAITING in markup and 'class="pcard-err"' not in markup
