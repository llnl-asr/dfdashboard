"""Counter series: per-pid, per-node and the Arrow payload the overlay reads.

Every method reads through the trace facade passed in, so the group carries
no state; the facade stays the only owner of the viewers."""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Optional

import numpy as np
import pyarrow as pa
from dftracer.utils import DataFrame
from dftracer.utils.columnar import F, count
from typing_extensions import NotRequired, TypedDict

from .frame import (
    Row,
    _agg,
    _empty,
    _first,
    _group,
    _num,
    _rows,
)
from .schema import (
    _READ,
    _SYSTEM_CATS,
    _WRITE,
    _counter_family,
    _entity_label,
    _ipc_stream,
)

if TYPE_CHECKING:
    from .data import TraceData


class Band(TypedDict):
    p10: list[float]
    p50: list[float]
    p90: list[float]


class CounterSeries(TypedDict):
    id: str
    name: str
    cat: str
    key: str
    family: str
    values: list[float]
    min: float
    max: float
    mean: float
    last: float


class SeriesPayload(TypedDict):
    begin: float
    bucket_us: float
    buckets: int
    series: list[CounterSeries]


class SplitRow(TypedDict):
    entity: str
    label: str
    values: list[float]
    min: float
    max: float
    mean: float
    last: float
    total: float


class SplitPayload(TypedDict):
    begin: float
    bucket_us: float
    buckets: int
    series_id: str
    dim: str
    entities: list[SplitRow]
    total_entities: int
    family: NotRequired[str]
    band: NotRequired[Band]


class HostSeries(TypedDict):
    name: str
    key: str
    values: list[float]
    counts: list[int]
    max: float


class HostRow(TypedDict):
    host: str
    series: list[HostSeries]


class NodeCountersPayload(TypedDict):
    begin: float
    bucket_us: float
    buckets: int
    hosts: list[HostRow]


def counters_arrow(
    trace: "TraceData",
    begin: float,
    end: float,
    buckets: int = 400,
    query: Optional[str] = None,
) -> bytes:
    # Per-bucket read/write bytes and op counts as three int columns; the
    # client rebuilds begin/bucket_us from its own query params.
    buckets = max(buckets, 1)
    bucket_us = max((end - begin) / buckets, 1)
    read = [0] * buckets
    write = [0] * buckets
    ops = [0] * buckets
    df = trace._window(begin, end, query, ("name", "ts", "ret"))
    if df.height and "ret" in df.columns:
        d = df.filter(F.ret > 0).assign(bucket=((F.ts - begin) / bucket_us).cast("int64"))
        for pattern, out in ((_READ, read), (_WRITE, write)):
            sel = d.filter(F.name.lower().regex(pattern))
            if sel.height == 0:
                continue
            grp = _agg(_group(sel, "bucket"), F.ret.sum().alias("total"), count().alias("n"))
            for r in _rows(grp):
                i = int(r["bucket"])
                if 0 <= i < buckets:
                    out[i] = int(r["total"] or 0)
                    ops[i] += int(r["n"])
    tbl = pa.table(
        {
            "read_bytes": pa.array(read, pa.int64()),
            "write_bytes": pa.array(write, pa.int64()),
            "ops": pa.array(ops, pa.int64()),
        }
    )
    return _ipc_stream(tbl)


def _counter_long(
    trace: "TraceData",
    begin: float,
    end: float,
    query: Optional[str],
    extra: tuple[str, ...] = (),
    phase: str = "counters",
) -> DataFrame:
    """Counter rows as (entity) x (name, cat, key, bucket) long form."""
    keys = trace._metric_keys
    want = ("name", "cat", "pid", "ts") + extra + keys
    d = trace._window(begin, end, query, want)
    if d.height == 0 or not keys:
        return _empty(("name", "cat", "key", "bucket", "entity", "v"), trace._arg_types)
    id_vars = [c for c in ("name", "cat", "pid", "ts") + extra if c in d.columns]
    long = d.unpivot(id_vars=id_vars, value_vars=list(keys)).rename(
        {"variable": "key", "value": "v"}
    )
    return long.filter(F.v.is_not_null())


def counter_series(
    trace: "TraceData",
    begin: float,
    end: float,
    width: int = 800,
    query: Optional[str] = None,
) -> SeriesPayload:
    # One downsampled series per (counter name, numeric args key), classified
    # by cat: system (sys/net/io, percentages) / aggregate (per-op stats) /
    # profile (epoch-step app metrics). We return true min/max so the view
    # can label real units.
    width = max(width, 1)
    bucket_us = max((end - begin) / width, 1)
    out = SeriesPayload(begin=begin, bucket_us=bucket_us, buckets=width, series=[])
    q = 'ph == "C"' if not query else f'ph == "C" and ({query})'
    long = _counter_long(trace, begin, end, q)
    if long.height == 0:
        return out
    long = long.assign(bucket=((F.ts - begin) / bucket_us).cast("int64"))
    system = long.filter(F.cat.lower().is_in(list(_SYSTEM_CATS) + ["profile"]))
    aggregate = long.filter(~F.cat.lower().is_in(list(_SYSTEM_CATS) + ["profile"]))
    groups: list[tuple[DataFrame, str]] = []
    if system.height:
        groups.append(
            (
                _agg(
                    _group(system, ["name", "cat", "key", "bucket"]),
                    F.v.mean().alias("m"),
                ),
                "mean",
            )
        )
    if aggregate.height:
        groups.append(
            (
                _agg(
                    _group(aggregate, ["name", "cat", "key", "bucket"]),
                    F.v.sum().alias("m"),
                ),
                "sum",
            )
        )
    series: list[Row] = []
    for grp, _reducer in groups:
        for r in _rows(grp.sort_values(["name", "cat", "key", "bucket"])):
            series.append(r)
    by_series: dict[tuple[str, str, str], list[float]] = {}
    for r in series:
        key = (str(r["name"]), str(r["cat"] or ""), str(r["key"]))
        arr = by_series.setdefault(key, [0.0] * width)
        b = int(r["bucket"])
        if 0 <= b < width:
            arr[b] = float(r["m"] or 0.0)
    out["series"] = [
        {
            "id": f"{name}/{key}",
            "name": name,
            "cat": cat,
            "key": key,
            "family": _counter_family(cat),
            "values": arr,
            "min": float(min(arr)),
            "max": float(max(arr)),
            "mean": float(sum(arr) / len(arr)),
            "last": float(arr[-1]),
        }
        for (name, cat, key), arr in by_series.items()
    ]
    out["series"].sort(key=lambda s: (s["family"], s["name"], s["key"]))
    return out


def counter_split(
    trace: "TraceData",
    begin: float,
    end: float,
    series_id: str,
    dim: str,
    width: int = 800,
    top: int = 32,
    query: Optional[str] = None,
) -> SplitPayload:
    # Per-entity breakdown of ONE counter (series_id = "name/key") along dim
    # "pid" or "node" (host hhash). Ranked by total; the top `top` become rows
    # and the rest fold into one "other" row, so the payload stays bounded.
    name, _, key = series_id.partition("/")
    width = max(width, 1)
    top = max(top, 1)
    bucket_us = max((end - begin) / width, 1)
    out = SplitPayload(
        begin=begin,
        bucket_us=bucket_us,
        buckets=width,
        series_id=series_id,
        dim=dim,
        entities=[],
        total_entities=0,
    )
    q = 'ph == "C"' if not query else f'ph == "C" and ({query})'
    keys = trace._metric_keys
    if key not in keys:
        return out
    want = ("name", "cat", "pid", "ts", "hhash", key)
    df = trace._window(begin, end, q, want)
    if df.height == 0:
        return out
    d = df.filter(F.name == name).filter(F(key).is_not_null())
    if d.height == 0:
        return out
    cat = str(_first(d.head(1))["cat"] or "")
    fam = _counter_family(cat)
    out["family"] = fam
    reducer = F.v.sum() if fam == "aggregate" else F.v.mean()
    entity = F.pid.astype("string") if dim == "pid" else F.hhash
    d = d.assign(v=F(key), entity=entity).filter(F.entity.is_not_null())
    d = d.assign(bucket=((F.ts - begin) / bucket_us).cast("int64"))

    def row_for(sub: DataFrame, label: str) -> SplitRow:
        grp = _agg(_group(sub, "bucket"), reducer.alias("m")).sort_values(
            ["bucket"], ascending=[True]
        )
        arr = [0.0] * width
        for r in _rows(grp):
            b = int(r["bucket"])
            if 0 <= b < width:
                arr[b] = float(r["m"] or 0.0)
        return SplitRow(
            entity="",
            label=label,
            values=arr,
            min=float(min(arr)),
            max=float(max(arr)),
            mean=float(sum(arr) / len(arr)),
            last=float(arr[-1]),
            total=float(_num(_first(_agg(_group(sub), F.v.sum()))["sum_v"])),
        )

    totals = _agg(_group(d, "entity"), F.v.sum().alias("t")).sort_values(["t"], ascending=[False])
    total_rows = _rows(totals)
    out["total_entities"] = totals.height
    keep = [str(r["entity"]) for r in total_rows[:top]]
    rows = []
    for e in keep:
        r = row_for(d.filter(F.entity == e), _entity_label(e, dim))
        r["entity"] = e
        rows.append(r)
    others = d.filter(~F.entity.is_in(keep))
    if others.height:
        r = row_for(others, f"+{totals.height - len(keep)} more")
        r["entity"] = "__other__"
        rows.append(r)
    out["entities"] = rows

    # Per-bucket spread across ALL entities (not just the top-K rows) so the
    # band view shows how (im)balanced the metric is over the whole fleet.
    per_eb = _agg(_group(d, ["entity", "bucket"]), reducer.alias("m"))
    qb = _agg(
        _group(per_eb, "bucket"),
        F.m.quantile(0.1).alias("p10"),
        F.m.quantile(0.5).alias("p50"),
        F.m.quantile(0.9).alias("p90"),
    )
    p10 = [0.0] * width
    p50 = [0.0] * width
    p90 = [0.0] * width
    for r in _rows(qb):
        b = int(r["bucket"])
        if 0 <= b < width:
            p10[b] = float(r["p10"] or 0.0)
            p50[b] = float(r["p50"] or 0.0)
            p90[b] = float(r["p90"] or 0.0)
    out["band"] = Band(p10=p10, p50=p50, p90=p90)
    return out


def node_counters(
    trace: "TraceData", begin: float, end: float, width: int = 800
) -> NodeCountersPayload:
    # System telemetry (cat sys/net/io) grouped by host for rendering on the
    # timeline's node rows. Counters carry hhash, not a hostname, so map each
    # event's pid to its host via the proctree (every counter has a pid).
    width = max(width, 1)
    bucket_us = max((end - begin) / width, 1)
    out = NodeCountersPayload(begin=begin, bucket_us=bucket_us, buckets=width, hosts=[])
    pid2host = _pid_host_map(
        trace,
    )
    if not pid2host:
        return out
    keys = trace._metric_keys
    if not keys:
        return out
    want = ("name", "cat", "pid", "ts") + keys
    df = trace._window(begin, end, 'ph == "C"', want)
    df = df.filter(F.cat.lower().is_in(list(_SYSTEM_CATS)))
    if df.height == 0:
        return out
    hosts = DataFrame.from_dict(
        {
            "pid": np.asarray([int(p) for p in pid2host], dtype=np.int64),
            "host": np.asarray(list(pid2host.values()), dtype=str),
        }
    )
    d = df.join(hosts, on="pid", how="left")
    d = d.assign(
        host=F.host.fillna("?"),  # ty: ignore[invalid-argument-type]  runtime accepts a string
        bucket=((F.ts - begin) / bucket_us).cast("int64"),
    )
    long = d.unpivot(id_vars=["host", "name", "cat", "bucket"], value_vars=list(keys)).rename(
        {"variable": "key", "value": "v"}
    )
    long = long.filter(F.v.is_not_null())
    if long.height == 0:
        return out
    emissions = _agg(_group(long, ["host", "name", "key", "bucket"]), count().alias("n"))
    means = _agg(_group(long, ["host", "name", "key", "bucket"]), F.v.mean().alias("m"))
    counts: dict[tuple[str, str, str], list[int]] = {}
    for r in _rows(emissions):
        k = (str(r["host"]), str(r["name"]), str(r["key"]))
        arr = counts.setdefault(k, [0] * width)
        b = int(r["bucket"])
        if 0 <= b < width:
            arr[b] = int(r["n"])
    values: dict[tuple[str, str, str], list[float]] = {}
    for r in _rows(means):
        k = (str(r["host"]), str(r["name"]), str(r["key"]))
        arr = values.setdefault(k, [0.0] * width)
        b = int(r["bucket"])
        if 0 <= b < width:
            arr[b] = float(r["m"] or 0.0)
    by_host: dict[str, list[HostSeries]] = defaultdict(list)
    for k, arr in values.items():
        host, name_, key_ = k
        by_host[host].append(
            HostSeries(
                name=name_,
                key=key_,
                values=arr,
                counts=counts.get(k, [0] * width),
                max=float(max(arr)),
            )
        )
    out["hosts"] = [HostRow(host=h, series=v) for h, v in sorted(by_host.items())]
    return out


def _pid_host_map(trace: "TraceData") -> dict[str, str]:
    # The proctree is static for a loaded trace; don't rebuild it per request.
    if trace._pid2host is None:
        nodes = trace.proctree().get("nodes", [])
        trace._pid2host = {str(n["pid"]): str(n.get("host") or "?") for n in nodes}
    return trace._pid2host
