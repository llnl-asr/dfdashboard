"""Run one dfanalyzer analysis inside this process.

dfanalyzer needs no child process: with ``cluster=none`` it uses no Dask, and
with ``cluster=external`` it attaches to the dashboard's own threads-only
cluster, so neither path starts a Nanny or installs signal handlers.

``dask_jobqueue`` (which dfanalyzer imports) does call ``signal.signal`` at
import time, and that only works in the main thread. Import it once from the
main thread with :func:`warmup`, then any worker thread can use it.

``hydra`` keeps global state, so runs in one process are serialized here.
"""

from __future__ import annotations

import dataclasses
import json
import os
import signal
import sys
import threading

_LOCK = threading.Lock()


def _scalar(v: object) -> object:
    item = getattr(v, "item", None)
    return item() if callable(item) else v


def warmup() -> bool:
    """Import dfanalyzer once, from the main thread.

    ``dask_jobqueue`` installs a SIGINT handler when it is imported, and
    ``signal.signal`` only works in the main thread: importing it later from a
    worker thread raises ``ValueError``. Import it here and put the previous
    handler back.
    """
    if "dftracer.analyzer" in sys.modules:
        return True
    if threading.current_thread() is not threading.main_thread():
        return False
    previous = signal.getsignal(signal.SIGINT)
    try:
        import dftracer.analyzer  # noqa: F401
    except Exception:
        return False
    finally:
        signal.signal(signal.SIGINT, previous)
    return True


def analyze(
    trace_path: str,
    time_granularity: float,
    out_dir: str,
    cluster: str = "none",
    scheduler_address: str = "",
) -> dict:
    """Analyze ``trace_path`` and return the payload the pipeline reports.

    Writes ``main_view.parquet`` (when the analyzer exposes a view) into
    ``out_dir`` and keeps dfanalyzer's own log under ``out_dir/hydra``.
    """
    from dftracer.analyzer import init_with_hydra

    os.makedirs(out_dir, exist_ok=True)
    overrides = [
        "analyzer=dftracer",
        f"trace_path={trace_path}",
        f"analyzer.time_granularity={time_granularity}",
        f"hydra.run.dir={os.path.join(out_dir, 'hydra')}",
    ]
    if scheduler_address:
        overrides += [
            "cluster=external",
            f"cluster.scheduler_address={scheduler_address}",
            "cluster.restart_on_connect=false",
        ]
    else:
        overrides.append("cluster=none")

    with _LOCK:
        wis = init_with_hydra(overrides)
        try:
            result = wis.analyze_trace()
            envelope = dataclasses.asdict(result.to_fact_envelope())
            raw = result.raw_stats
            stats = {k: _scalar(v) for k, v in dataclasses.asdict(raw).items()} if raw else {}
            layers = list(result.layers or [])

            columns: list[str] = []
            if layers:
                view = result.get_main_view(layers[0])
                if hasattr(view, "compute"):
                    view = view.compute()
                view = view.reset_index()
                columns = [str(c) for c in view.columns]
                view.to_parquet(os.path.join(out_dir, "main_view.parquet"))
        finally:
            wis.shutdown()

    payload = {
        "facts": envelope.get("facts") or [],
        "fact_count_by_view": envelope.get("fact_count_by_view") or {},
        "raw_stats": stats,
        "layers": layers,
        "columns": columns,
    }
    with open(os.path.join(out_dir, "result.json"), "w") as f:
        json.dump(payload, f, default=str)
    return payload
