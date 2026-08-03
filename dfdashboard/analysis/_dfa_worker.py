"""Run one dfanalyzer analysis in a subprocess, writing result.json + main_view.parquet.

dfanalyzer (via Dask) installs signal handlers that only work in a process's main
thread, so it cannot run inside the server's thread pool.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys


def _scalar(v: object) -> object:
    item = getattr(v, "item", None)
    return item() if callable(item) else v


def main() -> None:
    trace_path, time_granularity, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    from dftracer.analyzer import init_with_hydra  # ty: ignore[unresolved-import]

    wis = init_with_hydra(
        [
            "analyzer=dftracer",
            f"trace_path={trace_path}",
            f"analyzer.time_granularity={time_granularity}",
            "cluster=local",
            "cluster.processes=true",
        ]
    )
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

    with open(os.path.join(out_dir, "result.json"), "w") as f:
        json.dump(
            {
                "facts": envelope.get("facts") or [],
                "fact_count_by_view": envelope.get("fact_count_by_view") or {},
                "raw_stats": stats,
                "layers": layers,
                "columns": columns,
            },
            f,
            default=str,
        )


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()
    main()
