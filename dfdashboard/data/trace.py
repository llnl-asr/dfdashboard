"""Trace queries (info / events / density / proctree) in Python over the reader's
Arrow, so the timeline renders without the C++ dftracer_server."""

from __future__ import annotations

import bisect
import io
import json
import os
import threading
from collections import defaultdict
from collections.abc import Iterator
from typing import Any, Callable, Optional, Union

import numpy as np
import polars as pl
import pyarrow as pa
from dftracer.utils.trace_reader import TraceReader

from ._calltree import build_tree
from .metadata import MetadataCache, TraceMeta

# The reader's analysis schema (normalize=True) is a different, wide layout; the
# per-event view we want is the raw schema, with ts normalized in Python.
_VIEW_COLS = ("name", "cat", "pid", "tid", "ts", "dur", "ph")
_IO_CATS = ("POSIX", "STDIO", "IO")


def _counter_family(cat: str) -> str:
    c = (cat or "").lower()
    if c in ("sys", "net", "io"):
        return "system"
    if c == "profile":
        return "profile"
    return "aggregate"


def _entity_label(entity: str, dim: str) -> str:
    if entity == "__other__":
        return entity
    return f"pid {entity}" if dim == "pid" else f"node {entity[:8]}"


# Unified schema for streamed timeline slices: kind 0 = event, 1 = density block.
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
        ("args", pa.string()),  # raw JSON, individual events only
    ]
)


def _accumulate_proc(df: pl.DataFrame, proc: dict[int, list[int]]) -> None:
    if "args" not in df.columns:
        return
    io = df.with_columns(
        ret=pl.col("args").str.json_path_match("$.ret").cast(pl.Int64, strict=False)
    ).filter((pl.col("ret") > 0) & pl.col("name").str.contains(r"(?i)read|write"))
    grp = io.group_by("pid").agg(
        bytes=pl.col("ret").sum(),
        ops=pl.len(),
        busy=pl.col("dur").sum(),
    )
    for row in grp.iter_rows(named=True):
        s = proc.setdefault(int(row["pid"]), [0, 0, 0])
        s[0] += int(row["bytes"])
        s[1] += int(row["ops"])
        s[2] += int(row["busy"])


def _accumulate_layers(
    df: pl.DataFrame, layers: dict[str, str], files: set[str], io_files: set[str]
) -> None:
    if "cat" in df.columns:
        for nm, ct in df.select(["name", "cat"]).unique().iter_rows():
            if nm and nm not in layers:
                layers[nm] = ct or ""
    if "args" in df.columns:
        fh = df.with_columns(
            fhash=pl.col("args").str.json_path_match("$.fhash"),
            isio=pl.col("name").str.contains(r"(?i)read|write"),
        ).filter(pl.col("fhash").is_not_null())
        files |= set(fh["fhash"].to_list())
        io_files |= set(fh.filter(pl.col("isio"))["fhash"].to_list())


def _accumulate_hosts(df: pl.DataFrame, pid_hhash: dict[int, str]) -> None:
    if "args" not in df.columns:
        return
    h = df.with_columns(hh=pl.col("args").str.json_path_match("$.hhash")).filter(
        pl.col("hh").is_not_null()
    )
    for pid, hh in h.group_by("pid").agg(hh=pl.col("hh").first()).iter_rows():
        pid_hhash.setdefault(int(pid), hh)


class TraceData:
    def __init__(
        self,
        paths: Union[str, list[str]],
        index_dir: str = "",
        runtime: Optional[Any] = None,
    ) -> None:
        if isinstance(paths, str):
            paths = [paths]
        self._paths = [os.path.abspath(p) for p in paths]
        self._readers = [
            TraceReader(p, index_dir=index_dir, auto_build_index=True, runtime=runtime)
            for p in paths
        ]
        self._locks = [threading.Lock() for _ in self._readers]  # a reader is not reentrant
        self._info_lock = threading.Lock()
        self._cache = MetadataCache(index_dir, self._paths)
        self._meta: Optional[TraceMeta] = None
        self._runtime = runtime
        self._index_dir = index_dir
        self._pid2host: Optional[dict[str, str]] = None

    def _map(self, fn: Callable[[Any], Any], items: Any) -> list:
        # Reads release the GIL; fan them out on the dftracer runtime's pool.
        if self._runtime is None:
            return [fn(x) for x in items]
        handles = [self._runtime.submit(fn, x) for x in items]
        return [h.get() for h in handles]

    @property
    def cache_key(self) -> str:
        return self._cache.key

    @property
    def trace_dir(self) -> str:
        return os.path.dirname(self._paths[0]) if self._paths else ""

    @property
    def paths(self) -> list[str]:
        return list(self._paths)

    @property
    def index_dir(self) -> str:
        return self._index_dir

    def _read_all(self, reader: TraceReader, lock: threading.Lock, query: str) -> pl.DataFrame:
        with lock:
            return reader.read_arrow(query=query, normalize=False).to_polars()

    def info(self) -> TraceMeta:
        if self._meta is not None:
            return self._meta
        with self._info_lock:
            if self._meta is not None:
                return self._meta
            cached = self._cache.load(len(self._readers))
            self._meta = cached if cached is not None else self._scan()
            self._cache.save(self._meta)
        return self._meta

    def _scan(self) -> TraceMeta:
        gmin = gmax = None
        count = 0
        total_dur = io_dur = 0
        pids: set[int] = set()
        proc: dict[int, list[int]] = {}
        layers: dict[str, str] = {}
        files: set[str] = set()
        io_files: set[str] = set()
        pid_hhash: dict[int, str] = {}
        bounds: list[Optional[tuple[int, int]]] = [None] * len(self._readers)

        def read_idx(i: int) -> tuple[int, pl.DataFrame]:
            return i, self._read_all(self._readers[i], self._locks[i], "ts >= 0")

        for i, df in self._map(read_idx, range(len(self._readers))):
            if df.height == 0:
                continue
            lo, hi = df["ts"].min(), df["ts"].max()
            if not isinstance(lo, int) or not isinstance(hi, int):
                continue
            bounds[i] = (lo, hi)
            gmin = lo if gmin is None else min(gmin, lo)
            gmax = hi if gmax is None else max(gmax, hi)
            count += df.height
            total_dur += int(df["dur"].sum() or 0)
            if "cat" in df.columns:
                io_dur += int(df.filter(pl.col("cat").is_in(_IO_CATS))["dur"].sum() or 0)
            pids |= set(df["pid"].unique().to_list())
            _accumulate_proc(df, proc)
            _accumulate_layers(df, layers, files, io_files)
            _accumulate_hosts(df, pid_hhash)

        hhash_host, pid_host, pid_rank = self._read_headers()
        hosts = {}
        for pid in sorted(pids):
            host = pid_host.get(pid) or hhash_host.get(pid_hhash.get(pid, ""), "")
            if host:
                hosts[pid] = host
        return TraceMeta(
            global_min_ts=gmin or 0,
            global_max_ts=gmax or 0,
            num_events=count,
            total_bytes=sum(s[0] for s in proc.values()),
            total_io_busy=sum(s[2] for s in proc.values()),
            io_share=(io_dur / total_dur * 100) if total_dur else 0.0,
            bounds=bounds,
            pids=sorted(pids),
            proc=proc,
            layers=layers,
            file_count=len(files),
            io_file_count=len(io_files),
            hosts=hosts,
            ranks=pid_rank,
        )

    def _read_headers(self) -> tuple[dict[str, str], dict[int, str], dict[int, str]]:
        # HH/PR metadata (M phase) sits atop each file but is dropped by the
        # indexed view; read_lines gives the raw leading lines.
        def head(i: int) -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            with self._locks[i]:
                lines = self._readers[i].read_lines(end_line=32)
            for mv in lines:
                s = bytes(mv).decode("utf-8", "ignore").strip().rstrip(",").lstrip("[")
                if '"ph":"M"' not in s:
                    continue
                try:
                    out.append(json.loads(s))
                except ValueError:
                    pass
            return out

        hhash_host: dict[str, str] = {}
        pid_host: dict[int, str] = {}
        pid_rank: dict[int, str] = {}
        for events in self._map(head, range(len(self._readers))):
            for e in events:
                args = e.get("args") or {}
                pid = e.get("pid")
                if e.get("name") == "HH":
                    hh, host = args.get("hhash"), args.get("name")
                    if hh and host:
                        hhash_host[hh] = host
                    if host and pid is not None:
                        pid_host[int(pid)] = host
                elif e.get("name") == "PR":
                    rank = args.get("rank", args.get("value"))
                    if pid is not None and rank is not None:
                        pid_rank[int(pid)] = str(rank)
        return hhash_host, pid_host, pid_rank

    def layers(self) -> dict[str, Any]:
        m = self.info()
        return {"layers": m.layers, "total_files": m.file_count, "io_files": m.io_file_count}

    def proctree(self) -> dict[str, Any]:
        m = self.info()
        nodes = []
        for pid in m.pids:
            b, ops, busy = m.proc.get(pid, (0, 0, 0))
            nodes.append(
                {
                    "pid": pid,
                    "parent": -1,
                    "spawn_ts": 0,
                    "first_ts": 0,
                    "host": m.hosts.get(pid, ""),
                    "rank": m.ranks.get(pid, ""),
                    "bytes": b,
                    "io_ops": ops,
                    "io_busy": busy,
                }
            )
        return {"nodes": nodes}

    def _window(self, begin: float, end: float, query: Optional[str]) -> pl.DataFrame:
        bounds = self.info().bounds
        gmin = self.info().global_min_ts
        lo_abs = int(begin + gmin)
        hi_abs = int(end + gmin)
        clauses = [f"ts >= {lo_abs}", f"ts <= {hi_abs}"]
        if query:
            clauses.append(f"({query})")
        q = " and ".join(clauses)
        idxs = [
            i for i, b in enumerate(bounds) if b is not None and b[1] >= lo_abs and b[0] <= hi_abs
        ]
        if not idxs:
            return pl.DataFrame()

        def read(i: int) -> pl.DataFrame:
            return self._read_all(self._readers[i], self._locks[i], q)

        frames = [df for df in self._map(read, idxs) if df.height]
        if not frames:
            return pl.DataFrame()
        df = pl.concat(frames, how="diagonal")
        return df.with_columns((pl.col("ts") - gmin).alias("ts"))

    def _events_frame(self, begin: float, end: float, query: Optional[str]) -> pl.DataFrame:
        df = self._window(begin, end, query)
        if df.height == 0:
            return pl.DataFrame(schema={"name": pl.Utf8, "cat": pl.Utf8, "ts": pl.Int64})
        return df.select([c for c in _VIEW_COLS if c in df.columns])

    def events(self, begin: float, end: float, query: Optional[str] = None) -> list[dict[str, Any]]:
        return self._events_frame(begin, end, query).to_dicts()

    def events_arrow(self, begin: float, end: float, query: Optional[str] = None) -> bytes:
        df = self._events_frame(begin, end, query)
        dict_cols = [c for c in ("name", "cat", "ph") if c in df.columns]
        if dict_cols:
            df = df.with_columns(pl.col(c).cast(pl.Categorical) for c in dict_cols)
        buf = io.BytesIO()
        df.write_ipc_stream(buf)
        return buf.getvalue()

    def _containment_depths(
        self, big: pl.DataFrame, blocks: pl.DataFrame, begin: float, threshold: float
    ) -> tuple[list[int], list[int]]:
        # Per-lane containment nesting (mirrors the C++ assign_view_depths) so
        # dense lanes stack into sub-rows instead of one flat, merged bar.
        big_depth = [0] * big.height
        block_depth = [0] * blocks.height
        lanes: dict[tuple[int, int], list[tuple[float, float, bool, int]]] = defaultdict(list)
        for i, (pid, tid, ts, dur) in enumerate(
            big.select(["pid", "tid", "ts", "dur"]).iter_rows()
        ):
            lo = float(ts)
            lanes[(pid, tid)].append((lo, lo + max(float(dur), 0.0), False, i))
        if threshold > 0:
            for j, (pid, tid, col) in enumerate(blocks.select(["pid", "tid", "_col"]).iter_rows()):
                lo = begin + float(col) * threshold
                lanes[(pid, tid)].append((lo, lo + threshold, True, j))
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

    def _file_slices(self, df: pl.DataFrame, threshold: float, begin: float) -> pa.Table:
        big = df.filter(pl.col("dur") >= threshold)
        small = df.filter(pl.col("dur") < threshold)
        blocks = (
            small.with_columns(((pl.col("ts") - begin) / threshold).floor().alias("_col"))
            .group_by(["pid", "tid", "_col"])
            .agg(
                count=pl.len(),
                total=pl.col("dur").sum(),
                name=pl.col("name").sort_by("dur", descending=True).first(),
            )
        )
        big_depth, block_depth = self._containment_depths(big, blocks, begin, threshold)
        ev = big.with_columns(_depth=pl.Series(big_depth, dtype=pl.Int32)).select(
            kind=pl.lit(0, pl.Int8),
            pid=pl.col("pid").cast(pl.Int64),
            tid=pl.col("tid").cast(pl.Int64),
            ts=pl.col("ts").cast(pl.Float64),
            dur=pl.col("dur").cast(pl.Float64),
            name=pl.col("name"),
            cat=pl.col("cat"),
            ph=pl.col("ph"),
            count=pl.lit(1, pl.Int64),
            total=pl.col("dur").cast(pl.Float64),
            depth=pl.col("_depth"),
            args=(pl.col("args") if "args" in big.columns else pl.lit("", pl.Utf8)),
        )
        blk = blocks.with_columns(_depth=pl.Series(block_depth, dtype=pl.Int32)).select(
            kind=pl.lit(1, pl.Int8),
            pid=pl.col("pid").cast(pl.Int64),
            tid=pl.col("tid").cast(pl.Int64),
            ts=(begin + pl.col("_col") * threshold).cast(pl.Float64),
            dur=pl.lit(threshold, pl.Float64),
            name=pl.col("name"),
            cat=pl.lit("", pl.Utf8),
            ph=pl.lit("", pl.Utf8),
            count=pl.col("count").cast(pl.Int64),
            total=pl.col("total").cast(pl.Float64),
            depth=pl.col("_depth"),
            args=pl.lit("", pl.Utf8),
        )
        return pl.concat([ev, blk], how="vertical").to_arrow().cast(_SLICE_SCHEMA)

    def timeline_stream(
        self,
        begin: float,
        end: float,
        width: int = 1200,
        summary: int = 1,
        lookback: float = 0,
        query: Optional[str] = None,
    ) -> Iterator[bytes]:
        bounds = self.info().bounds
        gmin = self.info().global_min_ts
        threshold = max(end - begin, 1) / max(width, 1) * max(summary, 1)
        lo_abs = int(begin + gmin - lookback)
        hi_abs = int(end + gmin)
        clauses = [f"ts >= {lo_abs}", f"ts <= {hi_abs}"]
        if query:
            clauses.append(f"({query})")
        q = " and ".join(clauses)
        idxs = [
            i for i, b in enumerate(bounds) if b is not None and b[1] >= lo_abs and b[0] <= hi_abs
        ]

        def slices_for(i: int) -> Optional[pa.Table]:
            df = self._read_all(self._readers[i], self._locks[i], q)
            if df.height == 0:
                return None
            df = df.with_columns((pl.col("ts") - gmin).alias("ts"))
            return self._file_slices(df, threshold, begin)

        sink = io.BytesIO()
        writer = pa.ipc.new_stream(sink, _SLICE_SCHEMA)
        pos = 0

        def drain() -> bytes:
            nonlocal pos
            sink.seek(pos)
            chunk = sink.read()
            pos = sink.tell()
            return chunk

        for table in self._map(slices_for, idxs):
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

    def counters_arrow(
        self,
        begin: float,
        end: float,
        buckets: int = 400,
        query: Optional[str] = None,
    ) -> bytes:
        # Per-bucket read/write bytes and op counts as three int columns; the
        # client rebuilds begin/bucket_us from its own query params.
        bucket_us = max((end - begin) / max(buckets, 1), 1)
        read = [0] * buckets
        write = [0] * buckets
        ops = [0] * buckets
        df = self._window(begin, end, query)
        if df.height and "args" in df.columns:
            d = df.with_columns(
                ret=pl.col("args").str.json_path_match("$.ret").cast(pl.Int64, strict=False),
                bucket=((pl.col("ts") - begin) / bucket_us).floor().cast(pl.Int64),
            ).filter(pl.col("ret") > 0)
            for name_expr, out in ((r"(?i)read", read), (r"(?i)write", write)):
                grp = (
                    d.filter(pl.col("name").str.contains(name_expr))
                    .group_by("bucket")
                    .agg(total=pl.col("ret").sum(), n=pl.len())
                )
                for row in grp.iter_rows(named=True):
                    i = int(row["bucket"])
                    if 0 <= i < buckets:
                        out[i] = int(row["total"])
                        ops[i] += int(row["n"])
        tbl = pa.table(
            {
                "read_bytes": pa.array(read, pa.int64()),
                "write_bytes": pa.array(write, pa.int64()),
                "ops": pa.array(ops, pa.int64()),
            }
        )
        buf = io.BytesIO()
        with pa.ipc.new_stream(buf, tbl.schema) as w:
            w.write_table(tbl)
        return buf.getvalue()

    def counter_series(
        self, begin: float, end: float, width: int = 800, query: Optional[str] = None
    ) -> dict[str, Any]:
        # One downsampled series per (counter name, numeric args key), classified
        # by cat: system (sys/net/io, percentages) / aggregate (per-op stats) /
        # profile (epoch-step app metrics). The view normalizes; we return true
        # min/max so it can label real units.
        q = 'ph == "C"' if not query else f'ph == "C" and ({query})'
        df = self._window(begin, end, q)
        bucket_us = max((end - begin) / max(width, 1), 1)
        out: dict[str, Any] = {
            "begin": begin,
            "bucket_us": bucket_us,
            "buckets": width,
            "series": [],
        }
        if df.height == 0 or "args" not in df.columns:
            return out
        d = df.select(["name", "cat", "ts", "args"]).with_columns(
            bucket=((pl.col("ts") - begin) / bucket_us).floor().cast(pl.Int64)
        )
        series: list[dict[str, Any]] = []
        for name, cat in d.select(["name", "cat"]).unique().rows():
            g = d.filter((pl.col("name") == name) & (pl.col("cat") == cat))
            keys: dict[str, None] = {}
            for s in g["args"].head(6).to_list():
                try:
                    obj = json.loads(s)
                except Exception:
                    continue
                for k, v in obj.items():
                    if k not in ("hhash", "epoch", "step") and isinstance(v, (int, float)):
                        keys[k] = None
            fam = _counter_family(cat)
            # A counter is emitted per pid or per node, so a bucket holds one value
            # per emitter. Reduce by family: SUM the additive aggregate stats
            # (averaging under-reports by ~N), MEAN node percentages and profile.
            reducer = pl.col("v").sum() if fam == "aggregate" else pl.col("v").mean()
            for key in keys:
                vals = g.with_columns(
                    v=pl.col("args").str.json_path_match(f"$.{key}").cast(pl.Float64, strict=False)
                ).drop_nulls("v")
                if vals.height == 0:
                    continue
                grp = vals.group_by("bucket").agg(m=reducer).sort("bucket")
                arr = [0.0] * width
                for row in grp.iter_rows(named=True):
                    b = int(row["bucket"])
                    if 0 <= b < width:
                        arr[b] = float(row["m"] or 0.0)
                # Summarize the plotted (bucket-reduced) series, not raw per-emitter
                # events, so min/max/mean/last are correct for the summed families.
                mcol = grp["m"]
                series.append(
                    {
                        "id": f"{name}/{key}",
                        "name": name,
                        "cat": cat,
                        "key": key,
                        "family": fam,
                        "values": arr,
                        "min": float(mcol.min()),  # ty: ignore[invalid-argument-type]
                        "max": float(mcol.max()),  # ty: ignore[invalid-argument-type]
                        "mean": float(mcol.mean()),  # ty: ignore[invalid-argument-type]
                        "last": float(mcol[-1]),
                    }
                )
        series.sort(key=lambda s: (s["family"], s["name"], s["key"]))
        out["series"] = series
        return out

    def counter_split(
        self,
        begin: float,
        end: float,
        series_id: str,
        dim: str,
        width: int = 800,
        top: int = 32,
        query: Optional[str] = None,
    ) -> dict[str, Any]:
        # Per-entity breakdown of ONE counter (series_id = "name/key") along dim
        # "pid" or "node" (host hhash). Ranked by total; the top `top` become rows
        # and the rest fold into one "other" row, so the payload stays bounded.
        name, _, key = series_id.partition("/")
        q = 'ph == "C"' if not query else f'ph == "C" and ({query})'
        df = self._window(begin, end, q)
        bucket_us = max((end - begin) / max(width, 1), 1)
        out: dict[str, Any] = {
            "begin": begin,
            "bucket_us": bucket_us,
            "buckets": width,
            "series_id": series_id,
            "dim": dim,
            "entities": [],
            "total_entities": 0,
        }
        if df.height == 0 or "args" not in df.columns or "pid" not in df.columns:
            return out
        entity_col = (
            pl.col("args").str.json_path_match("$.hhash").fill_null("?")
            if dim == "node"
            else pl.col("pid").cast(pl.Utf8)
        )
        d = (
            df.filter(pl.col("name") == name)
            .select(["cat", "ts", "args", "pid"])
            .with_columns(
                bucket=((pl.col("ts") - begin) / bucket_us).floor().cast(pl.Int64),
                v=pl.col("args").str.json_path_match(f"$.{key}").cast(pl.Float64, strict=False),
                entity=entity_col,
            )
            .drop_nulls("v")
        )
        if d.height == 0:
            return out
        fam = _counter_family(d["cat"][0])
        out["family"] = fam
        reducer = pl.col("v").sum() if fam == "aggregate" else pl.col("v").mean()

        def row_for(sub: pl.DataFrame, entity: str, label: str) -> dict[str, Any]:
            grp = sub.group_by("bucket").agg(m=reducer).sort("bucket")
            arr = [0.0] * width
            for r in grp.iter_rows(named=True):
                b = int(r["bucket"])
                if 0 <= b < width:
                    arr[b] = float(r["m"] or 0.0)
            mcol = grp["m"]
            return {
                "entity": entity,
                "label": label,
                "values": arr,
                "min": float(mcol.min()),  # ty: ignore[invalid-argument-type]
                "max": float(mcol.max()),  # ty: ignore[invalid-argument-type]
                "mean": float(mcol.mean()),  # ty: ignore[invalid-argument-type]
                "last": float(mcol[-1]),
                "total": float(sub["v"].sum()),
            }

        totals = d.group_by("entity").agg(t=pl.col("v").sum()).sort("t", descending=True)
        out["total_entities"] = totals.height
        keep = totals["entity"].head(max(top, 1)).to_list()
        rows = [row_for(d.filter(pl.col("entity") == e), e, _entity_label(e, dim)) for e in keep]
        others = d.filter(~pl.col("entity").is_in(keep))
        if others.height:
            rows.append(row_for(others, "__other__", f"+{totals.height - len(keep)} more"))
        out["entities"] = rows

        # Per-bucket spread across ALL entities (not just the top-K rows) so the
        # band view shows how (im)balanced the metric is over the whole fleet.
        # Quantiles are over the entities active in each bucket.
        per_eb = d.group_by(["entity", "bucket"]).agg(m=reducer)
        qb = (
            per_eb.group_by("bucket")
            .agg(
                p10=pl.col("m").quantile(0.1),
                p50=pl.col("m").quantile(0.5),
                p90=pl.col("m").quantile(0.9),
            )
            .sort("bucket")
        )
        p10 = [0.0] * width
        p50 = [0.0] * width
        p90 = [0.0] * width
        for r in qb.iter_rows(named=True):
            b = int(r["bucket"])
            if 0 <= b < width:
                p10[b] = float(r["p10"] or 0.0)
                p50[b] = float(r["p50"] or 0.0)
                p90[b] = float(r["p90"] or 0.0)
        out["band"] = {"p10": p10, "p50": p50, "p90": p90}
        return out

    def _pid_host_map(self) -> dict[str, str]:
        # The proctree is static for a loaded trace; don't rebuild it per request.
        if self._pid2host is None:
            nodes = self.proctree().get("nodes", [])
            self._pid2host = {str(n["pid"]): str(n.get("host") or "?") for n in nodes}
        return self._pid2host

    def node_counters(self, begin: float, end: float, width: int = 800) -> dict[str, Any]:
        # System telemetry (cat sys/net/io) grouped by host for rendering on the
        # timeline's node rows. Counters carry hhash, not a hostname, so map each
        # event's pid to its host via the proctree (every counter has a pid).
        df = self._window(begin, end, 'ph == "C"')
        bucket_us = max((end - begin) / max(width, 1), 1)
        out: dict[str, Any] = {
            "begin": begin,
            "bucket_us": bucket_us,
            "buckets": width,
            "hosts": [],
        }
        if df.height == 0 or "args" not in df.columns or "pid" not in df.columns:
            return out
        pid2host = self._pid_host_map()
        if not pid2host:
            return out
        hosts_df = pl.DataFrame({"pid_s": list(pid2host.keys()), "host": list(pid2host.values())})
        d = (
            df.with_columns(pid_s=pl.col("pid").cast(pl.Utf8), c=pl.col("cat").str.to_lowercase())
            .filter(pl.col("c").is_in(["sys", "net", "io"]))
            .join(hosts_df, on="pid_s", how="left")
            .with_columns(
                bucket=((pl.col("ts") - begin) / bucket_us).floor().cast(pl.Int64),
                host=pl.col("host").fill_null("?"),
            )
        )
        if d.height == 0:
            return out
        hosts: list[dict[str, Any]] = []
        for host in d["host"].unique().sort().to_list():
            hd = d.filter(pl.col("host") == host)
            series: list[dict[str, Any]] = []
            for name, cat in hd.select(["name", "cat"]).unique().rows():
                g = hd.filter((pl.col("name") == name) & (pl.col("cat") == cat))
                # Raw emissions folded into each bucket, so the UI can say when a
                # displayed value is an average of N readings.
                counts = [0] * width
                for r in g.group_by("bucket").agg(c=pl.len()).iter_rows(named=True):
                    b = int(r["bucket"])
                    if 0 <= b < width:
                        counts[b] = int(r["c"])
                keys: dict[str, None] = {}
                for s in g["args"].head(6).to_list():
                    try:
                        obj = json.loads(s)
                    except Exception:
                        continue
                    for k, v in obj.items():
                        if k not in ("hhash", "epoch", "step") and isinstance(v, (int, float)):
                            keys[k] = None
                for key in keys:
                    vals = g.with_columns(
                        v=pl.col("args")
                        .str.json_path_match(f"$.{key}")
                        .cast(pl.Float64, strict=False)
                    ).drop_nulls("v")
                    if vals.height == 0:
                        continue
                    grp = vals.group_by("bucket").agg(m=pl.col("v").mean()).sort("bucket")
                    arr = [0.0] * width
                    for r in grp.iter_rows(named=True):
                        b = int(r["bucket"])
                        if 0 <= b < width:
                            arr[b] = float(r["m"] or 0.0)
                    series.append(
                        {
                            "name": name,
                            "key": key,
                            "values": arr,
                            "counts": counts,
                            "max": float(grp["m"].max()),  # ty: ignore[invalid-argument-type]
                        }
                    )
            if series:
                hosts.append({"host": host, "series": series})
        out["hosts"] = hosts
        return out

    def stats(
        self,
        begin: float,
        end: float,
        query: Optional[str] = None,
        group: str = "name",
    ) -> dict[str, Any]:
        df = self._window(begin, end, query)
        # Counter readings (ph="C") have no duration; they would show as 0-rows
        # in this operation-duration aggregation. Their own endpoints cover them.
        if "ph" in df.columns:
            df = df.filter(pl.col("ph") != "C")
        if df.height == 0:
            return {"count": 0, "total_dur": 0, "wall": 0, "truncated": False, "names": []}
        col = group if group in df.columns else "name"
        grp = (
            df.group_by(col)
            .agg(
                count=pl.len(),
                total=pl.col("dur").sum(),
                avg=pl.col("dur").mean(),
                min=pl.col("dur").min(),
                max=pl.col("dur").max(),
            )
            .sort("total", descending=True)
        )
        names = [
            {
                "name": str(r[col]),
                "count": int(r["count"]),
                "total": int(r["total"]),
                "avg": float(r["avg"] or 0),
                "min": int(r["min"] or 0),
                "max": int(r["max"] or 0),
            }
            for r in grp.iter_rows(named=True)
        ]
        hi = (df["ts"] + df["dur"]).max()
        lo = df["ts"].min()
        wall = int(hi) - int(lo) if isinstance(hi, int) and isinstance(lo, int) else 0
        return {
            "count": df.height,
            "total_dur": int(df["dur"].sum()),
            "wall": wall,
            "truncated": False,
            "names": names,
        }

    def _app_spans(self) -> list[tuple[int, int]]:
        # Per-process [start, end] absolute-us intervals from dftracer's start/end
        # records (cat=="dftracer", name in {"start","end"}), matching the server.
        q = 'cat == "dftracer" and (name == "start" or name == "end")'

        def rd(i: int) -> pl.DataFrame:
            return self._read_all(self._readers[i], self._locks[i], q)

        starts: dict[int, int] = {}
        ends: dict[int, int] = {}
        for df in self._map(rd, range(len(self._readers))):
            if df.height == 0 or "name" not in df.columns:
                continue
            for pid, ts, name in zip(df["pid"].to_list(), df["ts"].to_list(), df["name"].to_list()):
                if name == "start":
                    cur = starts.get(pid)
                    if cur is None or ts < cur:
                        starts[pid] = ts
                elif name == "end":
                    cur = ends.get(pid)
                    if cur is None or ts > cur:
                        ends[pid] = ts
        spans: list[tuple[int, int]] = []
        for pid, s in starts.items():
            e = ends.get(pid)
            if e is not None and e > s:
                spans.append((s, e))
        return spans

    @staticmethod
    def _merge(intervals: list[tuple[int, int]]) -> list[list[int]]:
        out: list[list[int]] = []
        for lo, hi in sorted(intervals):
            if out and lo <= out[-1][1]:
                out[-1][1] = max(out[-1][1], hi)
            else:
                out.append([lo, hi])
        return out

    def breaks(self) -> dict[str, Any]:
        # A break is dead time between runs: the complement of the intervals in
        # which some process is alive. Merge the alive-intervals, then skip only
        # the gaps big enough to be worth compressing (see _select_gaps), so a
        # trace with many runs does not produce a wall of tiny "skip" markers.
        info = self.info()
        gmin = info.global_min_ts
        total = info.global_max_ts - gmin
        if total <= 0:
            return {"gaps": [], "multi_run": False}

        spans = self._app_spans()
        if spans:
            merged = self._merge([(s - gmin, e - gmin) for s, e in spans])
        else:
            # Fallback: per-file bounds when there are no app-span records.
            bounds = [(b[0] - gmin, b[1] - gmin) for b in info.bounds if b is not None]
            if not bounds:
                return {"gaps": [], "multi_run": False}
            merged = self._merge(bounds)

        gaps = self._select_gaps(merged, total)
        return {"gaps": gaps, "multi_run": bool(gaps)}

    # Compress dead time worth compressing: keep only gaps at least a fraction of
    # the total span (so normal inter-run spacing stays as real time, not a skip
    # marker), capped to the largest few so pathological traces stay readable.
    _GAP_MIN_FRAC = 0.01
    _GAP_MIN_US = 50_000
    _GAP_MAX_COUNT = 40

    @classmethod
    def _select_gaps(cls, merged: list[list[int]], total: int) -> list[dict[str, int]]:
        min_gap = max(cls._GAP_MIN_US, cls._GAP_MIN_FRAC * total)
        gaps = [
            {"begin": a[1], "end": b[0]}
            for a, b in zip(merged, merged[1:])
            if b[0] - a[1] >= min_gap
        ]
        if len(gaps) > cls._GAP_MAX_COUNT:
            gaps = sorted(gaps, key=lambda g: g["end"] - g["begin"], reverse=True)
            gaps = sorted(gaps[: cls._GAP_MAX_COUNT], key=lambda g: g["begin"])
        return gaps

    def histogram(
        self, begin: float, end: float, query: Optional[str] = None, nbuckets: int = 48
    ) -> dict[str, Any]:
        empty = {
            "count": 0,
            "min": 0,
            "max": 0,
            "mean": 0,
            "p50": 0,
            "p90": 0,
            "p95": 0,
            "p99": 0,
            "truncated": False,
            "buckets": [],
        }
        df = self._window(begin, end, query)
        d = df.filter(pl.col("dur") > 0) if df.height else df
        if d.height == 0:
            return {**empty, "count": df.height}
        dur = d["dur"]
        lo, hi = dur.min(), dur.max()
        lo = float(lo) if isinstance(lo, (int, float)) else 0.0
        hi = float(hi) if isinstance(hi, (int, float)) else 0.0
        buckets: list[dict[str, float]] = []
        if hi > lo > 0:
            import math

            lg0, lg1 = math.log10(lo), math.log10(hi)
            edges = [10 ** (lg0 + (lg1 - lg0) * i / nbuckets) for i in range(nbuckets + 1)]
            binned = d.with_columns(
                _b=((pl.col("dur").log10() - lg0) / (lg1 - lg0) * nbuckets)
                .floor()
                .clip(0, nbuckets - 1)
                .cast(pl.Int64)
            )
            counts = [0] * nbuckets
            for row in binned.group_by("_b").agg(c=pl.len()).iter_rows(named=True):
                counts[int(row["_b"])] = int(row["c"])
            buckets = [
                {"lo": edges[i], "hi": edges[i + 1], "count": counts[i]} for i in range(nbuckets)
            ]
        q = {p: float(dur.quantile(p / 100) or 0) for p in (50, 90, 95, 99)}
        mean = dur.mean()
        return {
            "count": df.height,
            "min": lo,
            "max": hi,
            "mean": float(mean) if isinstance(mean, (int, float)) else 0.0,
            "p50": q[50],
            "p90": q[90],
            "p95": q[95],
            "p99": q[99],
            "truncated": False,
            "buckets": buckets,
        }

    def size_histogram(
        self, begin: float, end: float, query: Optional[str] = None, nbuckets: int = 48
    ) -> dict[str, Any]:
        # Log-scale distribution of transfer sizes (args.ret bytes for read/write).
        df = self._window(begin, end, query)
        if df.height == 0 or "args" not in df.columns:
            return {"count": 0, "buckets": []}
        d = df.with_columns(
            _sz=pl.col("args").str.json_path_match("$.ret").cast(pl.Int64, strict=False)
        ).filter((pl.col("_sz") > 0) & pl.col("name").str.contains(r"(?i)read|write"))
        if d.height == 0:
            return {"count": 0, "buckets": []}
        mn, mx = d["_sz"].min(), d["_sz"].max()
        lo = float(mn) if isinstance(mn, (int, float)) else 0.0
        hi = float(mx) if isinstance(mx, (int, float)) else 0.0
        buckets: list[dict[str, float]] = []
        if hi > lo > 0:
            import math

            lg0, lg1 = math.log10(lo), math.log10(hi)
            edges = [10 ** (lg0 + (lg1 - lg0) * i / nbuckets) for i in range(nbuckets + 1)]
            binned = d.with_columns(
                _b=((pl.col("_sz").log10() - lg0) / (lg1 - lg0) * nbuckets)
                .floor()
                .clip(0, nbuckets - 1)
                .cast(pl.Int64)
            )
            counts = [0] * nbuckets
            for row in binned.group_by("_b").agg(c=pl.len()).iter_rows(named=True):
                counts[int(row["_b"])] = int(row["c"])
            buckets = [
                {"lo": edges[i], "hi": edges[i + 1], "count": counts[i]} for i in range(nbuckets)
            ]
        elif hi == lo > 0:
            buckets = [{"lo": lo, "hi": lo, "count": d.height}]
        return {"count": d.height, "buckets": buckets}

    def op_stats(
        self, begin: float, end: float, query: Optional[str] = None
    ) -> dict[str, dict[str, float]]:
        # Per-operation time (s) / count / bytes over a window, by event name.
        patterns = [
            ("read", r"(?i)read|fgets"),
            ("write", r"(?i)write|fputs"),
            ("open", r"(?i)open"),
            ("close", r"(?i)close"),
            ("stat", r"(?i)stat"),
            ("seek", r"(?i)seek"),
            ("sync", r"(?i)sync|flush"),
        ]
        out: dict[str, dict[str, float]] = {
            op: {"time": 0.0, "count": 0, "bytes": 0} for op, _ in patterns
        }
        df = self._window(begin, end, query)
        if df.height == 0:
            return out
        ret = (
            pl.col("args").str.json_path_match("$.ret").cast(pl.Int64, strict=False)
            if "args" in df.columns
            else pl.lit(None, pl.Int64)
        )
        d = df.with_columns(_ret=ret)
        for op, pat in patterns:
            sel = d.filter(pl.col("name").str.contains(pat))
            if sel.height == 0:
                continue
            b = 0
            if op in ("read", "write"):
                b = int(sel.filter(pl.col("_ret") > 0)["_ret"].sum() or 0)
            out[op] = {
                "time": float(sel["dur"].sum() or 0) / 1e6,
                "count": sel.height,
                "bytes": b,
            }
        return out

    def access_pattern(
        self, begin: float, end: float, query: Optional[str] = None
    ) -> dict[str, Any]:
        # Sequential vs random reads. If read events carry an offset (POSIX
        # pread/pwrite), classify exactly by offset-delta: a read is sequential
        # iff offset == previous read's offset + bytes for that file. Otherwise
        # fall back to a seek heuristic: a read right after a seek is random.
        empty = {"sequential": 0, "random": 0, "seeks": 0, "method": "none"}
        df = self._window(begin, end, query)
        if df.height == 0 or "args" not in df.columns:
            return empty
        d = df.with_columns(
            _fh=pl.col("args").str.json_path_match("$.fhash"),
            _read=pl.col("name").str.contains(r"(?i)read|fgets"),
            _seek=pl.col("name").str.contains(r"(?i)seek"),
            _off=pl.col("args").str.json_path_match("$.offset").cast(pl.Int64, strict=False),
            _ret=pl.col("args").str.json_path_match("$.ret").cast(pl.Int64, strict=False),
        ).filter(pl.col("_fh").is_not_null() & (pl.col("_read") | pl.col("_seek")))
        if d.height == 0:
            return empty
        reads = d.filter(pl.col("_read"))
        seeks = d.filter(pl.col("_seek")).height

        if reads.height and reads.filter(pl.col("_off").is_not_null()).height >= reads.height * 0.5:
            r = reads.sort(["_fh", "ts"]).with_columns(
                _poff=pl.col("_off").shift(1).over("_fh"),
                _pret=pl.col("_ret").shift(1).over("_fh"),
            )
            seq = r.filter(
                pl.col("_poff").is_null()
                | pl.col("_off").is_null()
                | (pl.col("_off") == pl.col("_poff") + pl.col("_pret").fill_null(0))
            ).height
            return {
                "sequential": seq,
                "random": reads.height - seq,
                "seeks": seeks,
                "method": "offset",
            }

        d = d.sort(["_fh", "ts"]).with_columns(
            _prevseek=pl.col("_seek").shift(1).over("_fh").fill_null(False)
        )
        rd = d.filter(pl.col("_read"))
        random = rd.filter(pl.col("_prevseek")).height
        return {
            "sequential": rd.height - random,
            "random": random,
            "seeks": seeks,
            "method": "seek",
        }

    def calltree(
        self,
        begin: float,
        end: float,
        query: Optional[str] = None,
        by_process: bool = False,
        cap: int = 2_000_000,
    ) -> dict[str, Any]:
        df = self._window(begin, end, query)
        if df.height == 0:
            return {"truncated": False, "tree": build_tree([], [], [], [], [], [], by_process)}
        df = df.sort(["pid", "tid", "ts", "dur"], descending=[False, False, False, True])
        truncated = df.height > cap
        if truncated:
            df = df.head(cap)
        name_cat = df["name"].cast(pl.Categorical)
        cats = name_cat.cat.get_categories().to_list()
        codes = name_cat.to_physical().to_numpy().astype(np.int64)
        pids = df["pid"].to_numpy().astype(np.int64)
        tids = df["tid"].to_numpy().astype(np.int64)
        tss = df["ts"].to_numpy().astype(np.float64)
        durs = df["dur"].to_numpy().astype(np.float64)
        tree = build_tree(pids, tids, tss, durs, codes, cats, by_process)
        return {"truncated": truncated, "tree": tree}
