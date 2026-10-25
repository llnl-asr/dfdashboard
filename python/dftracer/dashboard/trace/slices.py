"""Event and timeline slices: the rows the canvas draws.

Every method reads through the trace facade passed in, so the group carries
no state; the facade stays the only owner of the viewers."""

from __future__ import annotations

import bisect
import io
from collections import defaultdict
from collections.abc import Iterator
from typing import TYPE_CHECKING, Optional

import numpy as np
import pyarrow as pa
from dftracer.utils import DataFrame, Series
from dftracer.utils.columnar import F, count

from ..data.run_types import EventRow, UntimedPayload
from .frame import (
    _agg,
    _arrow_table,
    _empty,
    _group,
    _int,
    _num,
    _ret_json,
)
from .schema import (
    _SLICE_SCHEMA,
    _ipc_stream,
)

if TYPE_CHECKING:
    from .data import TraceData


JSON_ROW_CAP = 20_000


def events(
    trace: "TraceData", begin: float, end: float, query: Optional[str] = None
) -> list[EventRow]:
    """Rows for the JSON API. Capped: one dict per row costs about 1 KB, so an
    uncapped call over a whole trace took 15 s and 124 MB. Arrow endpoints
    carry the whole window; this one pages."""
    df = trace._events_frame(begin, end, query)
    if df.height > JSON_ROW_CAP:
        df = df.head(JSON_ROW_CAP)
    return _event_rows(trace, df)


def untimed(
    trace: "TraceData", limit: int = 200, offset: int = 0, query: Optional[str] = None
) -> UntimedPayload:
    """Metadata (no clock) records, paged, for the view's "no time" list."""
    df = trace._metadata_frame(query)
    page = df.slice(offset, limit) if df.height else df
    return UntimedPayload(
        events=_event_rows(trace, trace._ph_strings(page)),
        count=df.height,
        offset=offset,
        limit=limit,
    )


def events_arrow(
    trace: "TraceData", begin: float, end: float, query: Optional[str] = None
) -> bytes:
    df = trace._events_frame(begin, end, query)
    tss = ("name", "cat", "pid", "tid", "ts", "dur", "ph")
    df = df.select([c for c in tss if c in df.columns])
    return _ipc_stream(
        _arrow_table(
            df,
            pa.schema(
                [
                    ("name", pa.string()),
                    ("cat", pa.string()),
                    ("pid", pa.int64()),
                    ("tid", pa.int64()),
                    ("ts", pa.int64()),
                    ("dur", pa.int64()),
                    ("ph", pa.string()),
                ]
            ),
        )
    )


def timeline_stream(
    trace: "TraceData",
    begin: float,
    end: float,
    width: int = 1200,
    summary: int = 1,
    lookback: float = 0,
    query: Optional[str] = None,
) -> Iterator[bytes]:
    m = trace.info()
    gmin = m.global_min_ts
    threshold = max(end - begin, 1) / max(width, 1) * max(summary, 1)
    lo_abs = int(begin + gmin - lookback)
    hi_abs = int(end + gmin)
    clauses = [f"ts >= {lo_abs}", f"ts <= {hi_abs}"]
    if query:
        clauses.append(f"({query})")
    q = " and ".join(clauses)
    idxs = [
        i for i, b in enumerate(m.bounds) if b is not None and b[1] >= lo_abs and b[0] <= hi_abs
    ]
    want = ("name", "cat", "pid", "tid", "ts", "dur", "ph", "ret", "dft_cnt", "dur_sum")

    def slices_for(i: int) -> Optional[pa.Table]:
        df = trace._read_file(i, want, q)
        if df.height == 0:
            return None
        df = trace._ph_strings(df.assign(ts=F.ts - gmin))
        return _file_slices(trace, df, threshold, begin, trace.file_runs.get(trace._paths[i], -1))

    sink = io.BytesIO()
    writer = pa.ipc.new_stream(sink, _SLICE_SCHEMA)
    pos = 0

    def drain() -> bytes:
        nonlocal pos
        sink.seek(pos)
        chunk = sink.read()
        pos = sink.tell()
        return chunk

    for table in trace._map(slices_for, idxs):
        if table is None or table.num_rows == 0:
            continue
        writer.write_table(table)
        chunk = drain()
        if chunk:
            yield chunk
    writer.close()
    chunk = drain()
    if chunk:
        yield chunk


def _event_rows(trace: "TraceData", df: DataFrame) -> list[EventRow]:
    if df.height == 0:
        return []
    data = df.to_dict()
    # The view reads the resolved hashes out of `args`, as the raw trace
    # carried them; in the index they are envelope columns.
    keys = trace._param_keys + ("fhash", "hhash")
    out: list[EventRow] = []
    for i in range(df.height):
        args: dict[str, str] = {k: str(data[k][i]) for k in keys if data[k][i] is not None}
        ph = str(data["ph"][i])
        count = data.get("dft_cnt", [None] * df.height)[i]
        total = data.get("dur_sum", [None] * df.height)[i]
        out.append(
            EventRow(
                name=str(data["name"][i]),
                cat=str(data["cat"][i]),
                pid=_int(data["pid"][i]),
                tid=_int(data["tid"][i]),
                ts=_int(data["ts"][i]),
                dur=_int(data["dur"][i]),
                ph=ph,
                agg=ph == "X" and count is not None,
                count=_int(count) if count is not None else 1,
                total=_int(total) if total is not None else _int(data["dur"][i]),
                args=args,
            )
        )
    return out


def _containment_depths(
    trace: "TraceData",
    big: DataFrame,
    blocks: DataFrame,
    begin: float,
    threshold: float,
) -> tuple[list[int], list[int]]:
    # Per-lane containment nesting (mirrors the C++ assign_view_depths) so
    # dense lanes stack into sub-rows instead of one flat, merged bar.
    big_depth = [0] * big.height
    block_depth = [0] * blocks.height
    lanes: dict[tuple[int, int], list[tuple[float, float, bool, int]]] = defaultdict(list)
    cols = big.select(["pid", "tid", "ts", "dur"]).to_dict()
    for i, (pid, tid, ts, dur) in enumerate(zip(cols["pid"], cols["tid"], cols["ts"], cols["dur"])):
        lo = _num(ts)
        lanes[(_int(pid), _int(tid))].append((lo, lo + max(_num(dur), 0.0), False, i))
    if threshold > 0:
        bcols = blocks.select(["pid", "tid", "_col"]).to_dict()
        for j, (pid, tid, c) in enumerate(zip(bcols["pid"], bcols["tid"], bcols["_col"])):
            lo = begin + _num(c) * threshold
            lanes[(_int(pid), _int(tid))].append((lo, lo + threshold, True, j))
    for items in lanes.values():
        items.sort(key=lambda x: (x[0], x[2]))  # opens before queries at equal ts
        open_ends: list[float] = []
        for ts, end, is_block, idx in items:
            k = bisect.bisect_right(open_ends, ts)
            if k:
                del open_ends[:k]
            if is_block:
                block_depth[idx] = len(open_ends) - bisect.bisect_left(open_ends, end)
            else:
                big_depth[idx] = len(open_ends)
                bisect.insort(open_ends, end)
    return big_depth, block_depth


def _file_slices(
    trace: "TraceData", df: DataFrame, threshold: float, begin: float, run: int = -1
) -> pa.Table:
    # An aggregated record already stands for many events; it is drawn even
    # when its window is shorter than the folding threshold.
    is_agg = F("dft_cnt").is_not_null() if "dft_cnt" in df.columns else None
    if is_agg is not None:
        aggregated = df.filter(is_agg)
        df = df.filter(~is_agg)
    else:
        aggregated = _empty(("kind",))
    big = df.filter(F.dur >= threshold)
    small = df.filter(F.dur < threshold)
    base = small.assign(_col=((F.ts - begin) / threshold).cast("int64"))
    top = (
        base.sort_values(["_col", "dur"], ascending=[True, False])
        .unique(subset=["pid", "tid", "_col"])
        .select(["pid", "tid", "_col", "name"])
    )
    blocks = _agg(
        _group(base, ["pid", "tid", "_col"]),
        count().alias("count"),
        F.dur.sum().alias("total"),
    )
    blocks = blocks.join(top, on=["pid", "tid", "_col"], how="left")
    big_depth, block_depth = _containment_depths(trace, big, blocks, begin, threshold)
    ev = (
        big.assign(_depth=Series.from_numpy(np.asarray(big_depth, dtype=np.int32)))
        .assign(
            kind=0,
            count=1,
            total=F.dur,
            depth=F("_depth"),
            args=_ret_json(big),
            agg=0,
            run=run,
        )
        .select(
            [
                "kind",
                "pid",
                "tid",
                "ts",
                "dur",
                "name",
                "cat",
                "ph",
                "count",
                "total",
                "depth",
                "args",
                "agg",
                "run",
            ]
        )
    )
    aggs = (
        aggregated.assign(
            kind=0,
            count=F("dft_cnt"),
            total=F("dur_sum"),
            depth=-1,
            args="",
            agg=1,
            run=run,
        ).select(
            [
                "kind",
                "pid",
                "tid",
                "ts",
                "dur",
                "name",
                "cat",
                "ph",
                "count",
                "total",
                "depth",
                "args",
                "agg",
                "run",
            ]
        )
        if aggregated.height
        else aggregated
    )
    blk = (
        blocks.assign(_depth=Series.from_numpy(np.asarray(block_depth, dtype=np.int32)))
        .assign(
            kind=1,
            ts=(begin + F("_col") * threshold),
            dur=threshold,
            cat="",
            ph="",
            depth=F("_depth"),
            args="",
            agg=0,
            run=run,
        )
        .select(
            [
                "kind",
                "pid",
                "tid",
                "ts",
                "dur",
                "name",
                "cat",
                "ph",
                "count",
                "total",
                "depth",
                "args",
                "agg",
                "run",
            ]
        )
    )
    parts = [p for p in (ev, aggs, blk) if p.height]
    out = parts[0] if len(parts) == 1 else parts[0].concat(*parts[1:], how="diagonal")
    return _arrow_table(out, _SLICE_SCHEMA)
