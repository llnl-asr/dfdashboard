"""FastAPI app: the viz router, response compression, and the frontend."""

from __future__ import annotations

import asyncio
import glob
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dftracer.utils import Runtime
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette_compress import CompressMiddleware

from .analysis.base import get_pipeline, load_plugins
from .analysis.docloop import bind as bind_doc_loop
from .analysis.panel_app import cards_embed_script, embed_script, mount_panel
from .analysis.pipelines import register_builtins
from .api import (
    dashboard_router,
    logs_router,
    prov_router,
    runs_router,
    runtime_router,
    tasks_router,
    viz_router,
)
from .cards import card_ids
from .compute.cluster import ClusterManager
from .compute.worker import set_worker_trace
from .config import Settings
from .core.errors import install_handlers
from .data.watch import RunRegistry, Watcher
from .runtime import EventBus, InProcessTaskBackend
from .runtime.logs import get_hub
from .runtime.pool import acquire as acquire_pools
from .runtime.pool import release as release_pools
from .trace import trace_data

# Arrow is left uncompressed: the middleware buffers streaming responses to
# compress them, which would defeat the progressive timeline stream. JSON
# endpoints (density/counters/stats) still get compressed.

log = logging.getLogger("dftracer.dashboard")


def _expand(trace_paths: list[str]) -> list[str]:
    files: list[str] = []
    for p in trace_paths:
        if os.path.isdir(p):
            files += sorted(glob.glob(os.path.join(p, "*.pfw.gz")))
        elif os.path.isfile(p):
            files.append(p)
    return files


def _index_dir(settings: Settings) -> str:
    d = settings.index_dir or os.path.join(
        os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
        "dftracer.dashboard",
        "index",
    )
    os.makedirs(d, exist_ok=True)
    return d


def create_app(settings: Settings) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub = get_hub()
        hub.install()
        hub.bind_loop(asyncio.get_running_loop())
        hub.start_stderr_capture()  # must tee before dftracer-utils inits
        app.state.loghub = hub
        bind_doc_loop(app)  # Bokeh builds documents in worker threads

        files = _expand(settings.trace_paths)
        pool_set = acquire_pools(settings.io_workers, settings.compute_workers)
        pool_set.bind(asyncio.get_running_loop())
        runtime = Runtime(python_threads=16)
        index_dir = _index_dir(settings)
        app.state.index_dir = index_dir
        app.state.scoped_traces = {}
        app.state.scoped_seq = -1
        registry: RunRegistry | None = None
        watcher: Watcher | None = None
        if settings.watch_root:
            registry = RunRegistry(
                settings.watch_root,
                index_dir,
                runtime=runtime,
                settle_s=settings.settle_s,
                stale_s=settings.stall_s,
                markers=settings.done_markers,
                pool=pool_set.io,
            )
            registry.refresh()
            log.info(
                "watching %s: %d run(s), %d file(s); index_dir=%s",
                settings.watch_root,
                len(registry.run_ids()),
                registry.n_files(),
                index_dir,
            )
            watcher = Watcher(
                registry,
                settings.watch_interval_s,
                on_change=lambda: set_worker_trace(registry.trace()),
            )
            watcher.start()
            trace = registry.trace()
        else:
            if settings.trace_paths and not files:
                raise RuntimeError(f"no .pfw.gz files found in: {settings.trace_paths}")
            log.info("loaded %d trace file(s); index_dir=%s", len(files), index_dir)
            source = (
                settings.trace_paths[0]
                if len(settings.trace_paths) == 1 and os.path.isdir(settings.trace_paths[0])
                else None
            )
            trace = (
                trace_data(files, index_dir=index_dir, runtime=runtime, source=source)
                if files
                else None
            )
        app.state.registry = registry
        app.state.n_files = len(files)
        app.state.trace = trace
        set_worker_trace(trace)  # same-process Dask workers reuse this handle

        register_builtins()
        load_plugins()
        events = EventBus()
        cluster = ClusterManager(settings.scheduler_address)
        backend = InProcessTaskBackend(
            get_pipeline,
            events,
            data=trace,
            data_provider=(lambda: registry.trace()) if registry is not None else None,
            client_provider=cluster.client,
        )
        await backend.start()
        app.state.events = events
        app.state.cluster = cluster
        app.state.backend = backend
        try:
            yield
        finally:
            if watcher is not None:
                watcher.stop()
            if registry is not None:
                registry.close()
            await backend.stop()
            await cluster.close()
            runtime.shutdown()
            release_pools()

    app = FastAPI(
        title="DFDashboard",
        lifespan=lifespan,
        # The documents live under /api with the routes they describe, so a
        # single prefix covers the API and the SPA catch-all never sees them.
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
    )
    install_handlers(app)
    app.add_middleware(CompressMiddleware)  # zstd -> brotli -> gzip
    app.include_router(viz_router)
    app.include_router(runs_router)
    app.include_router(prov_router)
    app.include_router(tasks_router)
    app.include_router(dashboard_router)
    app.include_router(logs_router)
    app.include_router(runtime_router)

    mount_panel(app)  # /panel doc + ws + autoload.js (no Tornado, no iframe)

    @app.get("/api/panel/embed")
    async def panel_embed(task: str = "") -> dict:
        return {"script": embed_script(task)}

    @app.get("/api/panel/cards/embed")
    async def panel_cards_embed(
        cards: str = "", begin: str = "", end: str = "", query: str = "", theme: str = "dark"
    ) -> dict:
        ids = [c for c in cards.split(",") if c] or card_ids()
        return {"script": cards_embed_script(ids, begin, end, query, theme)}

    # Wheels carry the built SPA at dfdashboard/web_dist; a source checkout
    # does not, and points --web-dist at web/dist instead.
    dist = Path(settings.web_dist) if settings.web_dist else Path(__file__).parent / "web_dist"
    if (dist / "index.html").is_file():
        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        # Registered last so /api and /assets win first.
        @app.get("/{path:path}")
        async def spa(path: str) -> FileResponse:
            f = dist / path
            if path and f.is_file():
                return FileResponse(f)
            return FileResponse(dist / "index.html")

    return app
