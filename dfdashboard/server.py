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
from .analysis.cards import card_ids
from .analysis.panel_app import cards_embed_script, embed_script, mount_panel
from .analysis.pipelines import register_builtins
from .api import dashboard_router, logs_router, runtime_router, tasks_router, viz_router
from .compute.cluster import ClusterManager
from .compute.worker import set_worker_trace
from .config import Settings
from .data._calltree import warmup
from .data.trace import TraceData
from .runtime import EventBus, InProcessTaskBackend
from .runtime.logs import get_hub

# Arrow is left uncompressed: the middleware buffers streaming responses to
# compress them, which would defeat the progressive timeline stream. JSON
# endpoints (density/counters/stats) still get compressed.

log = logging.getLogger("dfdashboard")


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
        "dfdashboard",
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

        files = _expand(settings.trace_paths)
        if settings.trace_paths and not files:
            raise RuntimeError(f"no .pfw.gz files found in: {settings.trace_paths}")
        runtime = Runtime(python_threads=16)
        index_dir = _index_dir(settings)
        log.info("loaded %d trace file(s); index_dir=%s", len(files), index_dir)
        app.state.index_dir = index_dir
        app.state.n_files = len(files)
        trace = TraceData(files, index_dir=index_dir, runtime=runtime) if files else None
        app.state.trace = trace
        set_worker_trace(trace)  # same-process Dask workers reuse this handle
        asyncio.create_task(asyncio.to_thread(warmup))  # JIT the flamegraph off-path

        register_builtins()
        load_plugins()
        events = EventBus()
        cluster = ClusterManager(settings.scheduler_address)
        backend = InProcessTaskBackend(
            get_pipeline, events, data=trace, client_provider=cluster.client
        )
        await backend.start()
        app.state.events = events
        app.state.cluster = cluster
        app.state.backend = backend
        try:
            yield
        finally:
            await backend.stop()
            await cluster.close()
            runtime.shutdown()

    app = FastAPI(title="DFDashboard", lifespan=lifespan)
    app.add_middleware(CompressMiddleware)  # zstd -> brotli -> gzip
    app.include_router(viz_router)
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
        cards: str = "", begin: str = "", end: str = "", query: str = ""
    ) -> dict:
        ids = [c for c in cards.split(",") if c] or card_ids()
        return {"script": cards_embed_script(ids, begin, end, query)}

    if settings.web_dist:
        dist = Path(settings.web_dist)
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
