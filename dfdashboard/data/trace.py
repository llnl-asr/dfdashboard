"""Trace queries (info / events / density / proctree) over dftracer-utils'
columnar engine.

Every read is a :class:`~dftracer.utils.TraceViewer` plan: the time window, the
user's duql predicate and the columns a payload needs are pushed into the
indexed scan, and the :class:`~dftracer.utils.DataFrame` that comes back does
the grouping, joins and windows. Nothing crosses into Python except the rows a
response actually carries.
"""

from __future__ import annotations

import bisect
import hashlib
import io
import math
import os
import re
import threading
from collections import OrderedDict, defaultdict
from collections.abc import Iterator, Sequence
from typing import Any, Callable, Literal, Optional, Union, cast

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
from dftracer.utils import DataFrame, DFTUtilsError, Series, TraceViewer
from dftracer.utils.columnar import F, GroupBy, count

from ._calltree import build_tree
from .metadata import MetadataCache, TraceMeta

# The engine keeps the trace's own units and phases; ours are the dashboard's.
_IO_CATS = ("POSIX", "STDIO", "IO")
_SYSTEM_CATS = ("sys", "net", "io")
_INTRINSIC = ("name", "cat", "pid", "tid", "ts", "dur", "ph")  # always indexed
_ENVELOPE = _INTRINSIC + ("fhash", "hhash")
# ph values in the index: 1 = X (duration event), 2 = C (counter), 4 = M (metadata).
_HASH_ARGS = ("fhash", "hhash")
_HASH_ENVELOPE = {"FH": "fhash", "HH": "hhash"}
_PH_COUNTER = 2
_PH_AGGREGATED = 3
_PH_METADATA = 4
# Arg keys that are bookkeeping, not metric series.
_NON_METRIC_ARGS = ("epoch", "step")
_READ = r"read|fgets|pread|read\w*"
_WRITE = r"write|fputs|pwrite|write\w*"
_SEEK = r"seek"

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
        ("args", pa.string()),  # JSON, individual events only
        ("agg", pa.int8()),  # 1 for an aggregated (ph=3) record
        ("run", pa.int32()),  # index into /api/runs order, -1 when unknown
    ]
)

_INT_TYPES = {"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"}
_FLOAT_TYPES = {"float32", "float64"}


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


def _dtype(value: str) -> str:
    """Column dtype of an index column, in numpy terms for empty frames."""
    if value in _INT_TYPES:
        return "int64"
    if value in _FLOAT_TYPES:
        return "float64"
    return "str"


def _empty(columns: tuple[str, ...], types: dict[str, str] | None = None) -> DataFrame:
    """An empty frame carrying the right dtype per column."""
    types = types or {}
    spec: dict[str, Any] = {}
    for c in columns:
        kind = types.get(c, "int64" if c in ("pid", "tid", "ts", "dur", "count") else "str")
        if kind == "float64":
            spec[c] = np.array([], dtype=np.float64)
        elif kind == "int64":
            spec[c] = np.array([], dtype=np.int64)
        else:
            spec[c] = np.array([], dtype=str)
    return DataFrame.from_dict(spec)


def _rows(df: DataFrame) -> list[dict[str, Any]]:
    data = df.to_dict()
    if not data:
        return []
    keys = list(data)
    return [dict(zip(keys, vals)) for vals in zip(*(data[k] for k in keys))]


def _first(df: DataFrame) -> dict[str, Any]:
    rows = _rows(df.head(1))
    return rows[0] if rows else {}


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) else 0.0


def _int(v: Any) -> int:
    return int(v) if isinstance(v, (int, float)) else 0


def _col(df: DataFrame, name: str) -> Series:
    """One column as a Series (the engine types ``df[name]`` as a union)."""
    return cast(Series, df[name])


def _group(df: DataFrame, *keys: Union[str, Sequence[str]]) -> GroupBy:
    """``DataFrame.group_by`` narrowed to the lazy ``GroupBy``."""
    return cast(GroupBy, df.group_by(*keys))  # ty: ignore[invalid-argument-type]


def _agg(gb: GroupBy, *aggs: Any) -> DataFrame:
    """``GroupBy.agg`` narrowed to a DataFrame."""
    return gb.agg(*aggs)


_OPEN_LOCK = threading.Lock()
_OPEN: "OrderedDict[tuple[str, tuple[str, ...]], TraceData]" = OrderedDict()
_OPEN_MAX = 8


def _index_path_for(index_dir: str, key: str) -> str:
    """One RocksDB directory per unit that a viewer reads on its own.

    The engine keeps its database open for the life of a viewer and never closes
    it. Two handles on one database corrupt it, seen as "Corruption: Mismatch in
    unique ID" or "Cannot upgrade RocksDB instance ... read-only to read-write
    while it is still in use", so a viewer that is read next to another viewer
    needs its own directory.
    """
    if not index_dir:
        return ""
    digest = hashlib.sha1(key.encode()).hexdigest()[:12]
    return os.path.join(index_dir, f"idx-{digest}")


_DB_LOCKS: dict[str, threading.RLock] = {}
_DB_LOCKS_GUARD = threading.Lock()


def _db_lock(index_path: str) -> threading.RLock:
    """The lock for one index database, shared by every viewer that opens it.

    A run trace and the union of runs both index the same file, so they can hold
    two handles on one database; they take the same lock for it, and distinct
    databases never wait for each other.
    """
    with _DB_LOCKS_GUARD:
        lock = _DB_LOCKS.get(index_path)
        if lock is None:
            lock = _DB_LOCKS[index_path] = threading.RLock()
        return lock


def trace_data(
    paths: Union[str, list[str]],
    index_dir: str = "",
    runtime: Optional[Any] = None,
    source: Optional[str] = None,
) -> "TraceData":
    """The one :class:`TraceData` for this file set, opened once per process."""
    if isinstance(paths, str):
        paths = [paths]
    key = (
        os.path.abspath(index_dir) if index_dir else "",
        tuple(sorted(os.path.abspath(p) for p in paths)),
    )
    with _OPEN_LOCK:
        hit = _OPEN.get(key)
        if hit is not None:
            _OPEN.move_to_end(key)
            return hit
        trace = TraceData(paths, index_dir=index_dir, runtime=runtime, source=source)
        _OPEN[key] = trace
        while len(_OPEN) > _OPEN_MAX:
            _OPEN.popitem(last=False)
        return trace


class TraceData:
    def __init__(
        self,
        paths: Union[str, list[str]],
        index_dir: str = "",
        runtime: Optional[Any] = None,
        source: Optional[str] = None,
    ) -> None:
        """``source`` is the directory the files came from, when they all did.

        A directory becomes one viewer, so the engine fans the files across its
        own threads and merges the schema in C++ (measured 8x faster than a
        per-file read plus a Python merge on 29 files). An explicit file list
        keeps one viewer per file, which is what keeps heterogeneous sets
        readable.
        """
        if isinstance(paths, str):
            paths = [paths]
        self._paths = [os.path.abspath(p) for p in paths]
        # Filled by the run registry: file path -> index into the run order, so
        # the timeline can group lanes and draw the band boundaries.
        self.file_runs: dict[str, int] = {}
        if source and os.path.isdir(source):
            index_paths = [_index_path_for(index_dir, source)]
            self._viewers = [
                TraceViewer(source, index_path=index_paths[0] or None, runtime=runtime)
            ]
        else:
            index_paths = [_index_path_for(index_dir, p) for p in self._paths]
            self._viewers = [
                TraceViewer(p, index_path=ip or None, runtime=runtime)
                for p, ip in zip(self._paths, index_paths)
            ]
        # The engine rebuilds a stale index inside a read, and a rebuild racing
        # another read on the same database fails with "Cannot upgrade RocksDB
        # instance ... while it is still in use", so reads on one database are
        # serialized while distinct databases keep reading in parallel.
        self._locks = [_db_lock(ip) for ip in index_paths]
        self._info = [v.column_info() for v in self._viewers]
        types: dict[str, str] = {}
        for info in self._info:
            for k, v in info.items():
                if k not in _ENVELOPE:
                    types.setdefault(k, _dtype(v))
        self._types = types
        self._params = tuple(sorted(types))
        self._metrics = tuple(
            k for k, t in sorted(types.items()) if t != "str" and k not in _NON_METRIC_ARGS
        )
        self._cache = MetadataCache(index_dir, self._paths)
        self._meta: Optional[TraceMeta] = None
        self._runtime = runtime
        self._index_dir = index_dir
        self._pid2host: Optional[dict[str, str]] = None
        self._files: Optional[dict[str, str]] = None
        self._hosts: Optional[dict[str, str]] = None
        self._meta_rows: Optional[DataFrame] = None

    # -- plumbing ----------------------------------------------------------------
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

    @property
    def _arg_types(self) -> dict[str, str]:
        """Every args key any file carries, and its numpy dtype."""
        return self._types

    @property
    def _param_keys(self) -> tuple[str, ...]:
        return self._params

    @property
    def _metric_keys(self) -> tuple[str, ...]:
        """Numeric args that are metric series (counters are split by these)."""
        return self._metrics

    def _map(self, fn: Callable[[Any], Any], items: Any) -> list:
        # Reads release the GIL; fan them out on the dftracer runtime's pool.
        if self._runtime is None:
            return [fn(x) for x in items]
        handles = [self._runtime.submit(fn, x) for x in items]
        return [h.get() for h in handles]

    def _collect(
        self,
        i: int,
        wanted: tuple[str, ...],
        query: Optional[str] = None,
        phase: Optional[Literal["events", "counters", "aggregated", "metadata", "any"]] = None,
    ) -> DataFrame:
        """One file's rows for ``wanted``, with only the fields the index has.

        A wanted name is an envelope field (``name``, ``ts``, ...), a resolved
        hash (``fhash``/``hhash``) or an args key, which the scan exposes as
        ``args.<key>``.
        """
        tv = self._viewers[i]
        if phase:
            tv = tv.phase(phase)
        if query:
            tv = tv.filter(query)
        info = self._info[i]
        names: list[str] = []
        rename: dict[str, str] = {}
        for w in wanted:
            if w in _INTRINSIC or (w in _ENVELOPE and w in info):
                names.append(w)
            elif w in info:
                names.append(f"args.{w}")
                rename[f"args.{w}"] = w
        if not names:
            return _empty(wanted, self._arg_types)
        with self._locks[i]:
            df = tv.select(names).collect()
        if rename:
            df = df.rename(rename)
        return df

    def _prepare(self, df: DataFrame, wanted: tuple[str, ...]) -> DataFrame:
        """Give a frame every ``wanted`` column and the dashboard's dtypes."""
        missing = [w for w in wanted if w not in df.columns]
        if missing:
            types = self._arg_types
            df = df.concat(
                _empty(tuple(missing), {w: types.get(w, "int64") for w in missing}),
                how="diagonal",
            )
        if df.height == 0:
            return _empty(wanted, self._arg_types)
        casts = {c: "int64" for c in ("pid", "tid", "ts", "dur") if c in df.columns}
        return df.cast(casts) if casts else df

    @staticmethod
    def _ph_strings(df: DataFrame) -> DataFrame:
        if "ph" not in df.columns:
            return df
        return df.assign(
            ph=_col(df, "ph")
            .astype("string")
            .str_replace(str(_PH_COUNTER), "C")
            .str_replace(str(_PH_METADATA), "M")
            .str_replace(str(_PH_AGGREGATED), "X")
            .str_replace("1", "X")
        )

    def _read_file(
        self,
        i: int,
        wanted: tuple[str, ...],
        query: Optional[str] = None,
        phase: Optional[Literal["events", "counters", "aggregated", "metadata", "any"]] = None,
    ) -> DataFrame:
        return self._prepare(self._collect(i, wanted, query, phase), wanted)

    def info(self) -> TraceMeta:
        if self._meta is not None:
            return self._meta
        cached = self._cache.load(len(self._viewers))
        self._meta = cached if cached is not None else self._scan()
        if cached is None:
            self._cache.save(self._meta)
        return self._meta

    def _scan(self) -> TraceMeta:
        want = ("name", "cat", "pid", "tid", "ts", "dur", "fhash", "hhash", "ret")
        gmin = gmax = None
        count = 0
        total_dur = io_dur = 0
        pids: set[int] = set()
        proc: dict[int, list[int]] = {}
        layers: dict[str, str] = {}
        files: set[str] = set()
        io_files: set[str] = set()
        pid_hhash: dict[int, str] = {}
        bounds: list[Optional[tuple[int, int]]] = [None] * len(self._viewers)

        def read(i: int) -> tuple[int, DataFrame]:
            return i, self._read_file(i, want)

        for i, df in self._map(read, range(len(self._viewers))):
            if df.height == 0:
                continue
            span = _first(
                _agg(
                    _group(df),
                    F.ts.min().alias("lo"),
                    F.ts.max().alias("hi"),
                    F.dur.sum().alias("dur"),
                )
            )
            lo, hi = int(span["lo"]), int(span["hi"])
            bounds[i] = (lo, hi)
            gmin = lo if gmin is None else min(gmin, lo)
            gmax = hi if gmax is None else max(gmax, hi)
            count += df.height
            total_dur += int(span["dur"] or 0)
            io_dur += int(
                _num(
                    _first(_agg(_group(df.filter(F.cat.is_in(list(_IO_CATS)))), F.dur.sum())).get(
                        "sum_dur"
                    )
                )
            )
            pids |= {_int(p) for p in _col(df, "pid").unique().to_list()}
            self._accumulate_proc(df, proc)
            for r in _rows(df.unique(subset=["name", "cat"]).select(["name", "cat"])):
                if r["name"] is not None:
                    layers.setdefault(str(r["name"]), str(r["cat"] or ""))
            hashes = df.filter(F.fhash.is_not_null()).select(["fhash"]).unique()
            files |= {str(h) for h in _col(hashes, "fhash").to_list()}
            io_hashes = (
                df.filter(F.fhash.is_not_null() & self._io_name()).select(["fhash"]).unique()
            )
            io_files |= {str(h) for h in _col(io_hashes, "fhash").to_list()}
            hosts = _agg(
                _group(df.filter(F.hhash.is_not_null()), "pid"),
                F.hhash.first().alias("hh"),
            )
            for r in _rows(hosts):
                pid_hhash.setdefault(int(r["pid"]), str(r["hh"]))

        hhash_host, pid_host, pid_rank = self._read_headers()
        hosts: dict[int, str] = {}
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

    @staticmethod
    def _io_name() -> Any:
        return F.name.lower().regex(_READ) | F.name.lower().regex(_WRITE)

    @classmethod
    def _accumulate_proc(cls, df: DataFrame, proc: dict[int, list[int]]) -> None:
        io = df.filter((F.ret > 0) & cls._io_name())
        if io.height == 0:
            return
        grp = _agg(
            _group(io, "pid"),
            F.ret.sum().alias("bytes"),
            count().alias("ops"),
            F.dur.sum().alias("busy"),
        )
        for r in _rows(grp):
            s = proc.setdefault(int(r["pid"]), [0, 0, 0])
            s[0] += int(r["bytes"] or 0)
            s[1] += int(r["ops"] or 0)
            s[2] += int(r["busy"] or 0)

    def _read_headers(self) -> tuple[dict[str, str], dict[int, str], dict[int, str]]:
        # HH/PR metadata (M phase) is not part of the event scan; the metadata
        # phase reads it with its args flattened (args.name = hostname).
        def head(i: int) -> DataFrame:
            with self._locks[i]:
                return self._viewers[i].phase("metadata").collect()

        hhash_host: dict[str, str] = {}
        pid_host: dict[int, str] = {}
        pid_rank: dict[int, str] = {}
        for md in self._map(head, range(len(self._viewers))):
            if md.height == 0:
                continue
            columns = md.columns
            for r in _rows(md):
                args = {
                    c[len("args.") :]: r[c]
                    for c in columns
                    if c.startswith("args.") and r[c] is not None
                }
                for c in ("hhash", "fhash"):
                    if c in columns and r[c] is not None:
                        args[c] = r[c]
                pid = r.get("pid")
                if r.get("name") == "HH":
                    hh, host = args.get("hhash"), args.get("name")
                    if hh and host:
                        hhash_host[str(hh)] = str(host)
                    if host and pid is not None:
                        pid_host[int(pid)] = str(host)
                elif r.get("name") == "PR":
                    rank = args.get("rank", args.get("value"))
                    if pid is not None and rank is not None:
                        pid_rank[int(pid)] = str(rank)
        return hhash_host, pid_host, pid_rank

    # -- static metadata -----------------------------------------------------------
    def metadata(self) -> DataFrame:
        """Every M-phase record (HH/PR/FH/SH), concatenated across files."""
        if self._meta_rows is None:
            frames = [
                md
                for md in self._map(
                    lambda i: self._viewers[i].phase("metadata").collect(),
                    range(len(self._viewers)),
                )
                if md.height
            ]
            self._meta_rows = (
                frames[0].concat(*frames[1:], how="diagonal")
                if len(frames) > 1
                else frames[0]
                if frames
                else _empty(("name", "cat", "pid", "args.name", "args.value"))
            )
        return self._meta_rows

    def files(self) -> dict[str, str]:
        """fhash -> path, from the FH metadata records."""
        if self._files is None:
            self._files = _hash_map(self.metadata(), "FH")
        return self._files

    def hosts(self) -> dict[str, str]:
        """hhash -> hostname, from the HH metadata records."""
        if self._hosts is None:
            self._hosts = _hash_map(self.metadata(), "HH")
        return self._hosts

    def scoped(self, file: str) -> "TraceData":
        """This trace restricted to the file ``file`` matches (path or basename)."""
        paths = [p for p in self._paths if p == file or os.path.basename(p) == file]
        if len(paths) == len(self._paths):
            return self
        if not paths:
            raise KeyError(file)
        return trace_data(paths, index_dir=self._index_dir, runtime=self._runtime)

    def columns(self) -> dict[str, str]:
        """Every column any trace file holds, with its index type name."""
        return {k: t for info in self._info for k, t in info.items()}

    def field_names(self) -> list[str]:
        """Column names as the view's query language spells them."""
        out: list[str] = []
        for name in self.columns():
            field = name if name in _ENVELOPE else f"args.{name}"
            if field not in out:
                out.append(field)
        return out

    def frames(
        self,
        columns: tuple[str, ...],
        *,
        query: Optional[str] = None,
        phase: Optional[Literal["events", "counters", "aggregated", "metadata", "any"]] = "any",
        chunk: int = 65536,
    ) -> Iterator[DataFrame]:
        """Bounded chunks of ``columns`` over the whole trace, file by file.

        ``columns`` are engine names (``args.used.0``, ``fhash``). A file that
        does not hold one leaves it out of its chunks.
        """
        for i, viewer in enumerate(self._viewers):
            info = self._info[i]
            names: list[str] = []
            # fhash/hhash are index envelope columns, not args columns; read
            # them as such and put the requested name back on the frame.
            for c in columns:
                if c.startswith("args.") and c[len("args.") :] in _HASH_ARGS:
                    names.append(c[len("args.") :])
                elif c in _INTRINSIC or c in _ENVELOPE or c in info or c.startswith("args."):
                    names.append(c)
            if not names:
                continue
            plan = viewer.phase(phase) if phase else viewer
            if query:
                plan = plan.filter(query)
            # The index catalog omits args of metadata records, so a candidate
            # column can be absent from a file even when another file has it.
            # One row validates the projection before the real stream runs.
            while True:
                try:
                    with self._locks[i]:
                        plan.select(names).limit(1).collect()
                    break
                except DFTUtilsError as exc:
                    missing = _missing_column(exc)
                    if missing is None or missing not in names:
                        raise
                    names.remove(missing)
                    if not names:
                        break
            if not names:
                continue
            renamed = {k: f"args.{k}" for k in _HASH_ARGS if k in names}
            stream = plan.stream(chunk)
            while True:
                with self._locks[i]:
                    frame = next(stream, None)
                if frame is None:
                    break
                if frame.height:
                    yield frame.rename(renamed) if renamed else frame

    def provenance(
        self,
        *,
        include_io: bool = True,
        include_all_files: bool = False,
        mounts: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        """The provenance graph in the web viewer's JSON shape."""
        from .provenance import build

        return build(
            self,
            include_io=include_io,
            include_all_files=include_all_files,
            mounts=mounts,
        )

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

    # -- windowed reads ------------------------------------------------------------
    def _window(
        self,
        begin: float,
        end: float,
        query: Optional[str],
        wanted: tuple[str, ...],
        phase: Optional[Literal["events", "counters", "aggregated", "metadata", "any"]] = None,
    ) -> DataFrame:
        m = self.info()
        gmin = m.global_min_ts
        lo_abs = int(begin + gmin)
        hi_abs = int(end + gmin)
        clauses = [f"ts >= {lo_abs}", f"ts <= {hi_abs}"]
        if query:
            clauses.append(f"({query})")
        q = " and ".join(clauses)
        idxs = [
            i for i, b in enumerate(m.bounds) if b is not None and b[1] >= lo_abs and b[0] <= hi_abs
        ]
        if not idxs:
            return _empty(wanted, self._arg_types)

        def read(i: int) -> DataFrame:
            return self._read_file(i, wanted, q, phase)

        frames = [df for df in self._map(read, idxs) if df.height]
        if not frames:
            return _empty(wanted, self._arg_types)
        df = frames[0] if len(frames) == 1 else frames[0].concat(*frames[1:], how="diagonal")
        df = self._prepare(df, wanted)
        if "ts" not in df.columns:
            return df
        return df.assign(ts=F.ts - gmin)

    def _events_frame(self, begin: float, end: float, query: Optional[str]) -> DataFrame:
        want = _INTRINSIC + ("fhash", "hhash") + self._param_keys
        df = self._window(begin, end, query, want)
        # Metadata (M phase) carries the host and file names but no clock, so
        # it never falls in a window; the view needs it to label events.
        meta = self._metadata_frame(query)
        if meta.height:
            df = meta if not df.height else df.concat(meta, how="diagonal")
        return self._ph_strings(df) if df.height else df

    def _metadata_frame(self, query: Optional[str] = None) -> DataFrame:
        meta = self.metadata()
        if not meta.height:
            return meta
        want = _INTRINSIC + ("fhash", "hhash") + self._param_keys
        df = self._prepare(meta, want) if any(c not in meta.columns for c in want) else meta
        if query:
            df = df.query(query)
        return df

    def events(self, begin: float, end: float, query: Optional[str] = None) -> list[dict[str, Any]]:
        return self._event_rows(self._events_frame(begin, end, query))

    def untimed(
        self, limit: int = 200, offset: int = 0, query: Optional[str] = None
    ) -> dict[str, Any]:
        """Metadata (no clock) records, paged, for the view's "no time" list."""
        df = self._metadata_frame(query)
        page = df.slice(offset, limit) if df.height else df
        return {
            "events": self._event_rows(self._ph_strings(page)),
            "count": df.height,
            "offset": offset,
            "limit": limit,
        }

    def _event_rows(self, df: DataFrame) -> list[dict[str, Any]]:
        if df.height == 0:
            return []
        data = df.to_dict()
        # The view reads the resolved hashes out of `args`, as the raw trace
        # carried them; in the index they are envelope columns.
        keys = self._param_keys + ("fhash", "hhash")
        out: list[dict[str, Any]] = []
        for i in range(df.height):
            args = {k: data[k][i] for k in keys if data[k][i] is not None}
            ph = data["ph"][i]
            count = data.get("dft_cnt", [None] * df.height)[i]
            total = data.get("dur_sum", [None] * df.height)[i]
            out.append(
                {
                    "name": data["name"][i],
                    "cat": data["cat"][i],
                    "pid": _int(data["pid"][i]),
                    "tid": _int(data["tid"][i]),
                    "ts": _int(data["ts"][i]),
                    "dur": _int(data["dur"][i]),
                    "ph": ph,
                    "agg": ph == "X" and count is not None,
                    "count": _int(count) if count is not None else 1,
                    "total": _int(total) if total is not None else _int(data["dur"][i]),
                    "args": args,
                }
            )
        return out

    def events_arrow(self, begin: float, end: float, query: Optional[str] = None) -> bytes:
        df = self._events_frame(begin, end, query)
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

    def _containment_depths(
        self, big: DataFrame, blocks: DataFrame, begin: float, threshold: float
    ) -> tuple[list[int], list[int]]:
        # Per-lane containment nesting (mirrors the C++ assign_view_depths) so
        # dense lanes stack into sub-rows instead of one flat, merged bar.
        big_depth = [0] * big.height
        block_depth = [0] * blocks.height
        lanes: dict[tuple[int, int], list[tuple[float, float, bool, int]]] = defaultdict(list)
        cols = big.select(["pid", "tid", "ts", "dur"]).to_dict()
        for i, (pid, tid, ts, dur) in enumerate(
            zip(cols["pid"], cols["tid"], cols["ts"], cols["dur"])
        ):
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
        self, df: DataFrame, threshold: float, begin: float, run: int = -1
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
        big_depth, block_depth = self._containment_depths(big, blocks, begin, threshold)
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

    def timeline_stream(
        self,
        begin: float,
        end: float,
        width: int = 1200,
        summary: int = 1,
        lookback: float = 0,
        query: Optional[str] = None,
    ) -> Iterator[bytes]:
        m = self.info()
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
            df = self._read_file(i, want, q)
            if df.height == 0:
                return None
            df = self._ph_strings(df.assign(ts=F.ts - gmin))
            return self._file_slices(df, threshold, begin, self.file_runs.get(self._paths[i], -1))

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
        buckets = max(buckets, 1)
        bucket_us = max((end - begin) / buckets, 1)
        read = [0] * buckets
        write = [0] * buckets
        ops = [0] * buckets
        df = self._window(begin, end, query, ("name", "ts", "ret"))
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
        self,
        begin: float,
        end: float,
        query: Optional[str],
        extra: tuple[str, ...] = (),
        phase: str = "counters",
    ) -> DataFrame:
        """Counter rows as (entity) x (name, cat, key, bucket) long form."""
        keys = self._metric_keys
        want = ("name", "cat", "pid", "ts") + extra + keys
        d = self._window(begin, end, query, want)
        if d.height == 0 or not keys:
            return _empty(("name", "cat", "key", "bucket", "entity", "v"), self._arg_types)
        id_vars = [c for c in ("name", "cat", "pid", "ts") + extra if c in d.columns]
        long = d.unpivot(id_vars=id_vars, value_vars=list(keys)).rename(
            {"variable": "key", "value": "v"}
        )
        return long.filter(F.v.is_not_null())

    def counter_series(
        self, begin: float, end: float, width: int = 800, query: Optional[str] = None
    ) -> dict[str, Any]:
        # One downsampled series per (counter name, numeric args key), classified
        # by cat: system (sys/net/io, percentages) / aggregate (per-op stats) /
        # profile (epoch-step app metrics). We return true min/max so the view
        # can label real units.
        width = max(width, 1)
        bucket_us = max((end - begin) / width, 1)
        out: dict[str, Any] = {
            "begin": begin,
            "bucket_us": bucket_us,
            "buckets": width,
            "series": [],
        }
        q = 'ph == "C"' if not query else f'ph == "C" and ({query})'
        long = self._counter_long(begin, end, q)
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
        series: list[dict[str, Any]] = []
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
        width = max(width, 1)
        top = max(top, 1)
        bucket_us = max((end - begin) / width, 1)
        out: dict[str, Any] = {
            "begin": begin,
            "bucket_us": bucket_us,
            "buckets": width,
            "series_id": series_id,
            "dim": dim,
            "entities": [],
            "total_entities": 0,
        }
        q = 'ph == "C"' if not query else f'ph == "C" and ({query})'
        keys = self._metric_keys
        if key not in keys:
            return out
        want = ("name", "cat", "pid", "ts", "hhash", key)
        df = self._window(begin, end, q, want)
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

        def row_for(sub: DataFrame, label: str) -> dict[str, Any]:
            grp = _agg(_group(sub, "bucket"), reducer.alias("m")).sort_values(
                ["bucket"], ascending=[True]
            )
            arr = [0.0] * width
            for r in _rows(grp):
                b = int(r["bucket"])
                if 0 <= b < width:
                    arr[b] = float(r["m"] or 0.0)
            return {
                "label": label,
                "values": arr,
                "min": float(min(arr)),
                "max": float(max(arr)),
                "mean": float(sum(arr) / len(arr)),
                "last": float(arr[-1]),
                "total": float(_num(_first(_agg(_group(sub), F.v.sum()))["sum_v"])),
            }

        totals = _agg(_group(d, "entity"), F.v.sum().alias("t")).sort_values(
            ["t"], ascending=[False]
        )
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
        width = max(width, 1)
        bucket_us = max((end - begin) / width, 1)
        out: dict[str, Any] = {
            "begin": begin,
            "bucket_us": bucket_us,
            "buckets": width,
            "hosts": [],
        }
        pid2host = self._pid_host_map()
        if not pid2host:
            return out
        keys = self._metric_keys
        if not keys:
            return out
        want = ("name", "cat", "pid", "ts") + keys
        df = self._window(begin, end, 'ph == "C"', want)
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
        by_host: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for k, arr in values.items():
            host, name_, key_ = k
            by_host[host].append(
                {
                    "name": name_,
                    "key": key_,
                    "values": arr,
                    "counts": counts.get(k, [0] * width),
                    "max": float(max(arr)),
                }
            )
        out["hosts"] = [{"host": h, "series": s} for h, s in sorted(by_host.items())]
        return out

    def stats(
        self,
        begin: float,
        end: float,
        query: Optional[str] = None,
        group: str = "name",
    ) -> dict[str, Any]:
        df = self._window(begin, end, query, _INTRINSIC)
        # Counter readings (ph=C) have no duration; they would show as 0-rows
        # in this operation-duration aggregation. Their own endpoints cover them.
        if df.height:
            df = df.filter(F.ph != _PH_COUNTER)
        if df.height == 0:
            return {"count": 0, "total_dur": 0, "wall": 0, "truncated": False, "names": []}
        key = group if group in df.columns else "name"
        grp = _agg(
            _group(df, key),
            count().alias("count"),
            F.dur.sum().alias("total"),
            F.dur.mean().alias("avg"),
            F.dur.min().alias("min"),
            F.dur.max().alias("max"),
        ).sort_values(["total"], ascending=[False])
        names = [
            {
                "name": str(r[key]),
                "count": int(r["count"]),
                "total": int(r["total"] or 0),
                "avg": float(r["avg"] or 0),
                "min": int(r["min"] or 0),
                "max": int(r["max"] or 0),
            }
            for r in _rows(grp)
        ]
        span = _first(_agg(_group(df), F.ts.min().alias("lo"), (F.ts + F.dur).max().alias("hi")))
        wall = int(span["hi"] or 0) - int(span["lo"] or 0)
        return {
            "count": df.height,
            "total_dur": int(_num(_first(_agg(_group(df), F.dur.sum()))["sum_dur"])),
            "wall": wall,
            "truncated": False,
            "names": names,
        }

    def _app_spans(self) -> list[tuple[int, int]]:
        # Per-process [start, end] absolute-us intervals from dftracer's start/end
        # records (cat=="dftracer", name in {"start","end"}), matching the server.
        q = 'cat == "dftracer" and (name == "start" or name == "end")'
        want = ("name", "pid", "ts")

        def rd(i: int) -> DataFrame:
            return self._read_file(i, want, q)

        starts: dict[int, int] = {}
        ends: dict[int, int] = {}
        for df in self._map(rd, range(len(self._viewers))):
            if df.height == 0:
                continue
            grp = _agg(_group(df, ["pid", "name"]), F.ts.min().alias("lo"), F.ts.max().alias("hi"))
            for r in _rows(grp):
                pid = int(r["pid"])
                if r["name"] == "start":
                    cur = starts.get(pid)
                    if cur is None or r["lo"] < cur:
                        starts[pid] = int(r["lo"])
                elif r["name"] == "end":
                    cur = ends.get(pid)
                    if cur is None or r["hi"] > cur:
                        ends[pid] = int(r["hi"])
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
        # The trustworthy window: the earliest a process began and the longest it
        # ran. An event outside it has impossible timing, which the timeline hides
        # by default so one bad record cannot drag the axis by days.
        app = self._app_spans()
        valid_start = max(0, min((s for s, _ in app), default=gmin) - gmin) if app else 0
        valid_end = max((e for _, e in app), default=info.global_max_ts) - gmin if app else 0
        max_life = max((e - s for s, e in app), default=0) if app else 0
        return {
            "gaps": gaps,
            "multi_run": bool(gaps),
            "valid_start": valid_start,
            "valid_end": valid_end,
            "max_life": max_life,
        }

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
        df = self._window(begin, end, query, ("dur",))
        d = df.filter(F.dur > 0) if df.height else df
        if d.height == 0:
            return {**empty, "count": df.height}
        dur = _col(d, "dur")
        lo, hi = _num(dur.min()), _num(dur.max())
        buckets: list[dict[str, float]] = []
        if hi > lo > 0:
            edges, counts = _log_hist(d, "dur", lo, hi, nbuckets)
            buckets = [
                {"lo": edges[i], "hi": edges[i + 1], "count": counts[i]} for i in range(nbuckets)
            ]
        return {
            "count": df.height,
            "min": lo,
            "max": hi,
            "mean": float(dur.mean()),
            "p50": float(dur.quantile(0.50)),
            "p90": float(dur.quantile(0.90)),
            "p95": float(dur.quantile(0.95)),
            "p99": float(dur.quantile(0.99)),
            "truncated": False,
            "buckets": buckets,
        }

    def size_histogram(
        self, begin: float, end: float, query: Optional[str] = None, nbuckets: int = 48
    ) -> dict[str, Any]:
        # Log-scale distribution of transfer sizes (args.ret bytes for read/write).
        df = self._window(begin, end, query, ("name", "ret"))
        if df.height == 0 or "ret" not in df.columns:
            return {"count": 0, "buckets": []}
        d = df.filter((F.ret > 0) & self._io_name())
        if d.height == 0:
            return {"count": 0, "buckets": []}
        ret = _col(d, "ret")
        lo, hi = _num(ret.min()), _num(ret.max())
        buckets: list[dict[str, float]] = []
        if hi > lo > 0:
            edges, counts = _log_hist(d, "ret", lo, hi, nbuckets)
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
            ("read", _READ),
            ("write", _WRITE),
            ("open", r"open"),
            ("close", r"close"),
            ("stat", r"stat"),
            ("seek", _SEEK),
            ("sync", r"sync|flush"),
        ]
        out: dict[str, dict[str, float]] = {
            op: {"time": 0.0, "count": 0, "bytes": 0} for op, _ in patterns
        }
        df = self._window(begin, end, query, ("name", "dur", "ret"))
        if df.height == 0:
            return out
        for op, pat in patterns:
            sel = df.filter(F.name.lower().regex(pat))
            if sel.height == 0:
                continue
            row = _first(_agg(_group(sel), F.dur.sum().alias("t"), count().alias("n")))
            b = 0
            if op in ("read", "write"):
                b = int(_num(_first(_agg(_group(sel.filter(F.ret > 0)), F.ret.sum()))["sum_ret"]))
            out[op] = {
                "time": float(row["t"] or 0) / 1e6,
                "count": int(row["n"] or 0),
                "bytes": b,
            }
        return out

    def proc_bytes(
        self, begin: float, end: float, query: Optional[str] = None
    ) -> list[dict[str, Any]]:
        # I/O bytes and busy time per process over a window, with the host that
        # ran it, sorted by bytes; backs the busiest and per-host cards.
        df = self._window(begin, end, query, ("name", "pid", "dur", "ret"))
        if df.height == 0:
            return []
        d = df.filter(F.name.lower().regex(_READ) | F.name.lower().regex(_WRITE))
        if d.height == 0:
            return []
        busy = _rows(_agg(_group(d, "pid"), count().alias("n"), F.dur.sum().alias("t")))
        moved = {
            int(r["pid"]): r["b"]
            for r in _rows(_agg(_group(d.filter(F.ret > 0), "pid"), F.ret.sum().alias("b")))
        }
        pid2host = self._pid_host_map()
        out = [
            {
                "pid": int(r["pid"]),
                "host": pid2host.get(str(int(r["pid"])), "?"),
                "bytes": _int(moved.get(int(r["pid"]))),
                "time_us": _num(r["t"]),
                "count": _int(r["n"]),
            }
            for r in busy
        ]
        return sorted(out, key=lambda p: -p["bytes"])

    def access_pattern(
        self, begin: float, end: float, query: Optional[str] = None
    ) -> dict[str, Any]:
        # Sequential vs random reads. If read events carry an offset (POSIX
        # pread/pwrite), classify exactly by offset-delta: a read is sequential
        # iff offset == previous read's offset + bytes for that file. Otherwise
        # fall back to a seek heuristic: a read right after a seek is random.
        empty = {"sequential": 0, "random": 0, "seeks": 0, "method": "none"}
        want = ("name", "ts", "fhash", "ret", "offset")
        df = self._window(begin, end, query, want)
        if df.height == 0 or "fhash" not in df.columns:
            return empty
        d = df.filter(
            F.fhash.is_not_null() & (F.name.lower().regex(_READ) | F.name.lower().regex(_SEEK))
        )
        if d.height == 0:
            return empty
        reads = d.filter(F.name.lower().regex(_READ))
        seeks = d.height - reads.height

        if reads.height and "offset" in reads.columns:
            offsets = reads.filter(F.offset.is_not_null()).height
            if offsets >= reads.height * 0.5:
                r = reads.window(
                    partition_by=["fhash"],
                    order_by=["ts"],
                    specs=[("lag", "offset", 1, "poff"), ("lag", "ret", 1, "pret")],
                )
                seq = r.filter(
                    F.poff.is_null()
                    | F.offset.is_null()
                    | (F.offset == (F.poff + F.pret.fillna(0)))
                ).height
                return {
                    "sequential": seq,
                    "random": reads.height - seq,
                    "seeks": seeks,
                    "method": "offset",
                }

        d = d.assign(_seek=F.name.lower().regex(_SEEK))
        w = d.window(
            partition_by=["fhash"],
            order_by=["ts"],
            specs=[("lag", "_seek", 1, "prevseek")],
        )
        rd = w.filter(~F("_seek"))
        random = rd.filter(F.prevseek.fillna(False)).height
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
        df = self._window(begin, end, query, ("name", "pid", "tid", "ts", "dur"))
        if df.height == 0:
            return {"truncated": False, "tree": build_tree([], [], [], [], [], [], by_process)}
        df = df.sort_values(["pid", "tid", "ts", "dur"], ascending=[True, True, True, False])
        truncated = df.height > cap
        if truncated:
            df = df.head(cap)
        names = _col(df, "name").to_list()
        codes_of: dict[str, int] = {}
        codes = np.fromiter(
            (codes_of.setdefault(str(n), len(codes_of)) for n in names),
            dtype=np.int64,
            count=len(names),
        )
        pids = _col(df, "pid").to_numpy().astype(np.int64)
        tids = _col(df, "tid").to_numpy().astype(np.int64)
        tss = _col(df, "ts").to_numpy().astype(np.float64)
        durs = _col(df, "dur").to_numpy().astype(np.float64)
        tree = build_tree(pids, tids, tss, durs, codes, list(codes_of), by_process)
        return {"truncated": truncated, "tree": tree}


def _hash_map(meta: DataFrame, record: str) -> dict[str, str]:
    """``value`` (the hash) -> ``args.name`` (its text) for one metadata record."""
    if meta.height == 0 or "name" not in meta.columns:
        return {}
    data = meta.to_dict()
    names = data.get("name") or []
    hashes = data.get("args.value") or data.get(_HASH_ENVELOPE[record]) or [None] * len(names)
    labels = data.get("args.name") or [None] * len(names)
    out: dict[str, str] = {}
    for kind, h, label in zip(names, hashes, labels):
        if kind == record and h and label:
            out.setdefault(str(h), str(label))
    return out


def _missing_column(exc: Exception) -> Optional[str]:
    m = re.search(r"no column named (\S+)", str(exc))
    return m.group(1) if m else None


def _ipc_stream(table: pa.Table) -> bytes:
    sink = io.BytesIO()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue()


def _arrow_table(df: DataFrame, schema: pa.Schema) -> pa.Table:
    """The frame as an Arrow table with ``schema``.

    A grouped column comes back dictionary-encoded over ``string_view`` values,
    which pyarrow 26 cannot cast or decode; rebuild those from their values.
    """
    table = df.to_arrow()
    arrays = []
    for field, column in zip(table.schema, table.columns):
        arr = column.combine_chunks()
        if pa.types.is_dictionary(field.type):
            values = arr.dictionary
            if pa.types.is_string_view(values.type):
                values = values.cast(pa.string())
            arr = pc.take(values, arr.indices.cast(pa.int64()))
        elif pa.types.is_string_view(field.type):
            arr = arr.cast(pa.string())
        arrays.append(arr)
    return pa.table(arrays, names=table.schema.names).cast(schema)


def _ret_json(df: DataFrame) -> Any:
    """The timeline's args payload: a minimal JSON object with the I/O size."""
    if "ret" not in df.columns:
        return ""
    pre = _col(df.assign(_p='{"ret":'), "_p")
    post = _col(df.assign(_q="}"), "_q")
    return pre.str_cat(_col(df, "ret").astype("string")).str_cat(post).fillna("")


def _log_hist(
    df: DataFrame, column: str, lo: float, hi: float, nbuckets: int
) -> tuple[list[float], list[int]]:
    lg0, lg1 = math.log10(lo), math.log10(hi)
    edges = [10 ** (lg0 + (lg1 - lg0) * i / nbuckets) for i in range(nbuckets + 1)]
    expr = F(column)
    binned = df.assign(
        _b=(((expr.log10() - lg0) / (lg1 - lg0)) * nbuckets)
        .floor()
        .clip(0, nbuckets - 1)
        .cast("int64")
    )
    counts = [0] * nbuckets
    for r in _rows(_agg(_group(binned, "_b"), count())):
        b = int(r["_b"])
        if 0 <= b < nbuckets:
            counts[b] = int(r["count"])
    return edges, counts
