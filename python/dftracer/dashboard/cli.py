"""dfdashboard-serve entrypoint."""

from __future__ import annotations

import argparse

from .config import Preset, Settings


def parse_args(argv: list[str] | None = None) -> Settings:
    p = argparse.ArgumentParser(prog="dfdashboard-serve")
    p.add_argument("--trace", nargs="+", default=[], help="trace files or dirs")
    p.add_argument("--watch", default=None, help="directory tree of runs to keep scanning")
    p.add_argument("--watch-interval", type=float, default=2.0, help="scan interval, seconds")
    p.add_argument(
        "--settle", type=float, default=60.0, help="quiet seconds before a split set is done"
    )
    p.add_argument(
        "--stall",
        type=float,
        default=300.0,
        help="quiet seconds before an unfinished run is stalled",
    )
    p.add_argument(
        "--done-marker",
        action="append",
        default=[],
        help="marker file that means a run is finished (repeatable; _SUCCESS/.done always count)",
    )
    p.add_argument("--preset", choices=[e.value for e in Preset], default=Preset.EMBEDDED.value)
    p.add_argument("--scheduler", default=None, help="external Dask scheduler address")
    p.add_argument("--io-workers", type=int, default=None, help="blocking I/O threads (default 32)")
    p.add_argument("--compute-workers", type=int, default=None, help="CPU-bound Python threads")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5006)
    p.add_argument("--web-dist", default=None, help="directory holding the frontend index.html")
    p.add_argument("--index-dir", default=None, help="trace index dir (default: user cache)")
    a = p.parse_args(argv)
    return Settings.for_preset(
        Preset(a.preset),
        trace_paths=a.trace,
        watch_root=a.watch,
        watch_interval_s=a.watch_interval,
        settle_s=a.settle,
        stall_s=a.stall,
        done_markers=a.done_marker,
        io_workers=a.io_workers,
        compute_workers=a.compute_workers,
        scheduler_address=a.scheduler,
        host=a.host,
        port=a.port,
        web_dist=a.web_dist,
        index_dir=a.index_dir,
    )


def main(argv: list[str] | None = None) -> None:
    import logging

    import uvicorn

    from .runtime.logs import get_hub
    from .server import create_app

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    get_hub().install()
    settings = parse_args(argv)
    # timeout_graceful_shutdown bounds the wait for long-lived SSE; the handle_exit
    # hook releases the always-on log stream immediately so Ctrl-C exits at once.
    config = uvicorn.Config(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        timeout_graceful_shutdown=3,
    )
    server = uvicorn.Server(config)
    orig_handle_exit = server.handle_exit

    def handle_exit(sig: int, frame: object) -> None:
        try:
            get_hub().close()
        except Exception:
            pass
        orig_handle_exit(sig, frame)  # ty: ignore[invalid-argument-type]

    server.handle_exit = handle_exit  # ty: ignore[invalid-assignment]
    try:
        server.run()
    except KeyboardInterrupt:
        pass  # asyncio.run re-raises this after a clean shutdown; stay quiet


if __name__ == "__main__":
    main()
