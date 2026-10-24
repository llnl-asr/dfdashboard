"""The Bokeh card app must fill its roots from a worker thread.

Bokeh 3.10 initializes a new document in a worker thread, where no event loop
runs, so scheduling the card fills with asyncio.ensure_future() raises
"There is no current event loop". This pins the doc-loop scheduling.
"""

import asyncio
import gzip
import os

import pytest

pytest.importorskip("dftracer.utils")

from fastapi.testclient import TestClient  # noqa: E402

from dfdashboard.analysis import cards as cards_mod  # noqa: E402
from dfdashboard.config import Settings  # noqa: E402
from dfdashboard.server import create_app  # noqa: E402


def _write_trace(directory: str) -> str:
    lines: list[str] = []
    base = 1_000_000
    for i in range(6):
        lines.append(
            f'{{"name":"read","cat":"POSIX","pid":1,"tid":1,"ts":{base + i * 100},'
            f'"dur":10,"ph":"X","args":{{"ret":1024}}}}'
        )
    path = os.path.join(directory, "t.pfw.gz")
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def test_cards_fill_from_the_document_worker_thread(tmp_path, monkeypatch):
    app = create_app(
        Settings(trace_paths=[_write_trace(str(tmp_path))], index_dir=str(tmp_path / "idx"))
    )

    scheduled = []
    real_spawn = cards_mod.spawn

    def recording_spawn(app_: object, coro: object) -> object:
        fut = real_spawn(app_, coro)
        scheduled.append(fut)
        return fut

    monkeypatch.setattr(cards_mod, "spawn", recording_spawn)

    with TestClient(app) as client:
        res = client.get(f"{cards_mod.CARDS_PATH}/autoload.js?bokeh-autoload-element=x")
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
    from types import SimpleNamespace

    return SimpleNamespace(state=SimpleNamespace(registry=registry, trace=None))


async def test_live_card_repaints_only_when_the_tree_changes(monkeypatch):
    monkeypatch.setattr(cards_mod, "REFRESH_S", 0.01)
    registry = _Registry()
    app = _app_with(registry)
    paints: list[int] = []

    async def fill(_doc: object) -> None:
        paints.append(registry.seq)

    task = asyncio.create_task(cards_mod._live(app, "c", fill, None))
    await asyncio.sleep(0.1)
    assert paints == [1], "an unchanged tree must not repaint"

    registry.seq = 2
    await asyncio.sleep(0.1)
    assert paints == [1, 2], "a moved seq must repaint once"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_live_card_paints_once_without_a_watcher(monkeypatch):
    monkeypatch.setattr(cards_mod, "REFRESH_S", 0.01)
    paints: list[int] = []

    async def fill(_doc: object) -> None:
        paints.append(len(paints))

    await asyncio.wait_for(cards_mod._live(_app_with(None), "c", fill, None), timeout=5)
    assert paints == [0]


async def test_live_card_survives_a_failing_fill(monkeypatch):
    monkeypatch.setattr(cards_mod, "REFRESH_S", 0.01)
    registry = _Registry()
    app = _app_with(registry)
    calls: list[int] = []

    async def fill(_doc: object) -> None:
        calls.append(registry.seq)
        if len(calls) == 1:
            raise RuntimeError("index is still being built")

    task = asyncio.create_task(cards_mod._live(app, "c", fill, None))
    await asyncio.sleep(0.1)
    registry.seq = 2
    await asyncio.sleep(0.1)
    assert calls == [1, 2], "a failed paint must not kill the loop"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_io_by_host_asks_again_instead_of_reusing_a_cached_result(monkeypatch):
    from types import SimpleNamespace

    specs: list[object] = []

    async def fake_run(_app: object, spec: object, *_a: object, **_k: object) -> object:
        specs.append(spec)
        return SimpleNamespace(data={"bytes_by_host": {"node1": 1}})

    monkeypatch.setattr(cards_mod, "_run_task", fake_run)
    app = SimpleNamespace(state=SimpleNamespace(trace=object(), registry=None))
    _card, fill = cards_mod._io_by_host(app, "dark")

    class Doc:
        def add_next_tick_callback(self, cb: object) -> None:
            cb()  # type: ignore[operator]

    await fill(Doc())
    await fill(Doc())
    assert len(specs) == 2, "a second fill must not be served from the result cache"
    assert getattr(specs[0], "cache") is False


def test_every_card_shows_the_same_busy_indicator():
    html = cards_mod._html_card("X", "loading...")
    markup = html.object  # ty: ignore[unresolved-attribute]
    assert "pcard-busy" in markup, "an HTML card must show a spinner like the canvas cards"
    css = cards_mod._CARD_CSS
    assert ".pcard-dot" in css and "pcard-spin" in css


async def test_io_by_host_waits_instead_of_failing_without_a_trace(monkeypatch):
    from types import SimpleNamespace

    calls: list[object] = []

    async def fake_run(_app: object, spec: object, *_a: object, **_k: object) -> object:
        calls.append(spec)
        raise AssertionError("the pipeline must not run without a trace")

    monkeypatch.setattr(cards_mod, "_run_task", fake_run)
    app = SimpleNamespace(state=SimpleNamespace(trace=None, registry=None))
    card, fill = cards_mod._io_by_host(app, "dark")

    class Doc:
        def add_next_tick_callback(self, cb: object) -> None:
            cb()  # type: ignore[operator]

    await fill(Doc())
    assert calls == []
    markup = card.object  # ty: ignore[unresolved-attribute]
    assert cards_mod.WAITING in markup and 'class="pcard-err"' not in markup
