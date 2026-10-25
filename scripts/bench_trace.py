"""Timing for the trace paths, so a shape change has a number to beat.

uv run python scripts/bench_trace.py /path/to/tree [runs]
"""

from __future__ import annotations

import sys
import time
import tracemalloc

from dftracer.dashboard.trace import TraceData
from dftracer.dashboard.trace.data import _Window
from dftracer.dashboard.trace.questions.ops import OP_STATS


def timeit(label: str, fn) -> None:
    tracemalloc.start()
    started = time.perf_counter()
    out = fn()
    ms = (time.perf_counter() - started) * 1e3
    peak = tracemalloc.get_traced_memory()[1] / 1e6
    tracemalloc.stop()
    print(f"{label:<28} {ms:9.1f} ms  peak {peak:7.1f} MB", flush=True)
    return out


def main() -> None:
    root = sys.argv[1]
    td = TraceData(root, index_dir=f"{root}-bench-idx")
    span = td.info().global_max_ts - td.info().global_min_ts
    window = _Window(0, span, None)
    print(f"root {root}  rows {td.info().num_events}  span_us {span}")

    a = timeit("op_stats (direct)", lambda: td.op_stats(0, span))
    b = timeit("ask 1 question", lambda: td.ask(window, [OP_STATS]))
    c = timeit("ask 4 questions", lambda: td.ask(window, [OP_STATS] * 4))
    print("direct == ask:", a == b["op_stats"], "| 4-question ask:", len(c))


main()
