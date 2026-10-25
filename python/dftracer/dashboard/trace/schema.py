"""Trace vocabulary shared by the query groups.

The engine keeps the trace's own units and phases; these are the dashboard's.
"""

from __future__ import annotations

import io

import pyarrow as pa

_IO_CATS = ("POSIX", "STDIO", "IO")

_SYSTEM_CATS = ("sys", "net", "io")

_INTRINSIC = ("name", "cat", "pid", "tid", "ts", "dur", "ph")  # always indexed

_ENVELOPE = _INTRINSIC + ("fhash", "hhash")

_HASH_ARGS = ("fhash", "hhash")

_HASH_ENVELOPE = {"FH": "fhash", "HH": "hhash"}

_PH_COUNTER = 2

_PH_AGGREGATED = 3

_PH_METADATA = 4

_NON_METRIC_ARGS = ("epoch", "step")

_READ = r"read|fgets|pread|read\w*"

_WRITE = r"write|fputs|pwrite|write\w*"

_SEEK = r"seek"

_SLICE_SCHEMA = pa.schema(
    [
        ("kind", pa.int8()),
        ("pid", pa.int64()),
        ("tid", pa.int64()),
        ("ts", pa.float64()),
        ("dur", pa.float64()),
        ("name", pa.string()),
        ("cat", pa.string()),
        ("ph", pa.string()),
        ("count", pa.int64()),
        ("total", pa.float64()),
        ("depth", pa.int32()),
        ("args", pa.string()),  # JSON, individual events only
        ("agg", pa.int8()),  # 1 for an aggregated (ph=3) record
        ("run", pa.int32()),  # index into /api/runs order, -1 when unknown
    ]
)


def _counter_family(cat: str) -> str:
    c = (cat or "").lower()
    if c in _SYSTEM_CATS:
        return "system"
    if c == "profile":
        return "profile"
    return "aggregate"


def _entity_label(entity: str, dim: str) -> str:
    if entity == "__other__":
        return entity
    return f"pid {entity}" if dim == "pid" else f"node {entity[:8]}"


def _ipc_stream(table: pa.Table) -> bytes:
    sink = io.BytesIO()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue()
