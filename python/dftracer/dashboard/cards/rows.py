"""Pure row shapers: trace payload in, `(name, magnitude, label)` rows out.

`magnitude` drives the bar width, `label` is the printed value. Keeping these
free of Panel and Bokeh lets the shapes be tested without a document.
"""

from __future__ import annotations

from typing import Any

from .format import fmt_bytes, fmt_time

OP_ORDER = ["read", "write", "open", "close", "stat", "seek", "sync"]
META_OPS = ["open", "close", "stat", "seek", "sync"]

Row = tuple[str, float, str]


def rows_op_time(st: dict) -> list[Row]:
    rows = [(op, st[op]["time"], fmt_time(st[op]["time"])) for op in OP_ORDER if st[op]["time"] > 0]
    return sorted(rows, key=lambda r: -r[1])


def rows_op_counts(st: dict) -> list[Row]:
    rows = [
        (op, float(st[op]["count"]), f"{int(st[op]['count']):,}")
        for op in OP_ORDER
        if st[op]["count"] > 0
    ]
    return sorted(rows, key=lambda r: -r[1])


def rows_busiest(procs: list[dict[str, Any]]) -> list[Row]:
    top = sorted(procs, key=lambda p: -p["bytes"])[:12]
    return [
        (f"proc {p['pid']}", float(p["bytes"]), fmt_bytes(p["bytes"]))
        for p in top
        if p["bytes"] > 0
    ]


def rows_read_write(st: dict) -> list[Row]:
    return [(op, float(st[op]["bytes"]), fmt_bytes(st[op]["bytes"])) for op in ("read", "write")]


def rows_avg_xfer(st: dict) -> list[Row]:
    out = []
    for op in ("read", "write"):
        c, b = st[op]["count"], st[op]["bytes"]
        if c > 0:
            out.append((op, b / c, fmt_bytes(b / c)))
    return out


def rows_data_meta(st: dict) -> list[Row]:
    data = st["read"]["time"] + st["write"]["time"]
    meta = sum(st[op]["time"] for op in META_OPS)
    return [("data", data, fmt_time(data)), ("metadata", meta, fmt_time(meta))]


def rows_bw_by_host(procs: list[dict[str, Any]]) -> list[Row]:
    moved: dict[str, list[float]] = {}
    for p in procs:
        acc = moved.setdefault(str(p["host"]), [0.0, 0.0])
        acc[0] += float(p["bytes"])
        acc[1] += float(p["time_us"])
    rows = []
    for host, (size, busy_us) in moved.items():
        bw = size / (busy_us / 1e6) if busy_us > 0 else 0.0
        rows.append((host, bw, f"{fmt_bytes(bw)}/s"))
    return sorted(rows, key=lambda r: -r[1])[:12]


def rows_host_bytes(by_host: dict[str, float]) -> list[Row]:
    pairs = sorted(by_host.items(), key=lambda kv: -kv[1])[:12]
    return [(h, float(v), fmt_bytes(v)) for h, v in pairs]


def rows_access(ap: dict[str, Any]) -> tuple[list[Row], str]:
    total = (ap["sequential"] + ap["random"]) or 1
    rows = [
        (label, float(v), f"{v:,} ({v / total * 100:.1f}%)")
        for label, v in (("sequential", ap["sequential"]), ("random", ap["random"]))
    ]
    note = "exact, by read offsets" if ap.get("method") == "offset" else "estimated from seeks"
    return rows, note
