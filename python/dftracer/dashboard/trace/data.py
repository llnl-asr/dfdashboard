"""Trace queries (info / events / density / proctree) over dftracer-utils'
columnar engine.

Every read is a :class:`~dftracer.utils.TraceViewer` plan: the time window, the
user's duql predicate and the columns a payload needs are pushed into the
indexed scan, and the :class:`~dftracer.utils.DataFrame` that comes back does
the grouping, joins and windows. Nothing crosses into Python except the rows a
response actually carries.
"""

from __future__ import annotations

import os
import re
import threading
from collections import OrderedDict
from collections.abc import Iterator
from typing import Any, Callable, Literal, Optional, Union

import pyarrow as pa
from dftracer.utils import DataFrame, DFTUtilsError, TraceViewer
from dftracer.utils.columnar import Expr as Expr
from dftracer.utils.columnar import F, count

from ..data.metadata import MetadataCache, TraceMeta
from ..data.prov_types import ProvGraph
from ..data.run_types import EventRow, UntimedPayload
from . import counters as C
from . import slices as S
from . import tree as T
from .counters import NodeCountersPayload, SeriesPayload, SplitPayload
from .frame import (
    _agg,
    _col,
    _dtype,
    _empty,
    _first,
    _group,
    _int,
    _num,
    _rows,
)
from .index import _db_lock, _index_path_for
from .questions import Question
from .questions import Window as _Window
from .questions.breaks import APP_SPAN_QUERY, Breaks
from .questions.latency import Histogram, SizeHistogram
from .questions.ops import AccessPattern, OpStats, Stats
from .questions.procs import ProcBytes
from .questions.types import (
    AccessPatternPayload,
    BreaksPayload,
    CalltreePayload,
    HistogramPayload,
    OpStatsPayload,
    ProcBytesPayload,
    SizeHistogramPayload,
    StatsPayload,
)
from .schema import (
    _ENVELOPE,
    _HASH_ARGS,
    _HASH_ENVELOPE,
    _INTRINSIC,
    _IO_CATS,
    _NON_METRIC_ARGS,
    _PH_AGGREGATED,
    _PH_COUNTER,
    _PH_METADATA,
    _READ,
    _WRITE,
)

_INT_TYPES = {"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"}
_FLOAT_TYPES = {"float32", "float64"}


# One open TraceData per file set. Bounded, because a watch session sees a new
# file set every time a run grows.
_OPEN: "OrderedDict[tuple[str, tuple[str, ...]], TraceData]" = OrderedDict()
_OPEN_LOCK = threading.Lock()
_OPEN_MAX = 8


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
        self._setview: Optional[Any] = None

    def _columns(self, wanted: tuple[str, ...], i: int) -> tuple[dict[str, str], list[str]]:
        """A wanted name is an envelope field, a resolved hash, or an args key,
        which the scan exposes as ``args.<key>``. Same rule as ``_collect``."""
        info = self._info[i]
        names: list[str] = []
        rename: dict[str, str] = {}
        for w in wanted:
            if w in _INTRINSIC or (w in _ENVELOPE and w in info):
                names.append(w)
            elif w in info:
                names.append(f"args.{w}")
                rename[f"args.{w}"] = w
        return rename, names

    def one[P](self, w: "_Window", q: "Question[P]") -> P:
        """One question over one window: read, then shape.

        A plan depends only on its columns, never on the question's fields, so
        two descriptors that differ only in an argument share a scan.
        """
        m = self.info()
        gmin = m.global_min_ts
        lo, hi = int(w.begin + gmin), int(w.end + gmin)
        clauses = [f"ts >= {lo}", f"ts <= {hi}"]
        if w.query:
            clauses.append(f"({w.query})")
        query = " and ".join(clauses)
        idxs = [i for i, b in enumerate(m.bounds) if b is not None and b[1] >= lo and b[0] <= hi]
        frames: list[DataFrame] = []
        for i in idxs:
            tv = self._viewers[i]
            if w.phase:
                tv = tv.phase(w.phase)
            tv = tv.filter(query)
            rename, names = self._columns(q.columns, i)
            # TODO(session): run these in one session once dftracer-utils can
            # stream or release a plan's result before the whole batch
            # executes. As it stands a session holds every result set at once:
            # five row-heavy plans took 1725 ms against 486 ms one by one on
            # 32 files / 1.44M rows.
            with self._locks[i]:
                result = tv.select(names).collect()
            if rename:
                result = result.rename(rename)
            if result.height:
                frames.append(result)
        if len(frames) == 1:
            frame = frames[0]
        elif frames:
            frame = frames[0].concat(*frames[1:], how="diagonal")
        else:
            frame = _empty(q.columns, self._arg_types)
        return q.shape(self._prepare(frame, q.columns), self)

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
    ) -> ProvGraph:
        """The provenance graph in the web viewer's JSON shape."""
        from ..data.provenance import build

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

    def events(self, begin: float, end: float, query: Optional[str] = None) -> list[EventRow]:
        return S.events(self, begin=begin, end=end, query=query)

    def untimed(
        self, limit: int = 200, offset: int = 0, query: Optional[str] = None
    ) -> UntimedPayload:
        return S.untimed(self, limit=limit, offset=offset, query=query)

    def _event_rows(self, df: DataFrame) -> list[EventRow]:
        return S._event_rows(self, df=df)

    def events_arrow(self, begin: float, end: float, query: Optional[str] = None) -> bytes:
        return S.events_arrow(self, begin=begin, end=end, query=query)

    def _containment_depths(
        self, big: DataFrame, blocks: DataFrame, begin: float, threshold: float
    ) -> tuple[list[int], list[int]]:
        return S._containment_depths(self, big=big, blocks=blocks, begin=begin, threshold=threshold)

    def _file_slices(
        self, df: DataFrame, threshold: float, begin: float, run: int = -1
    ) -> pa.Table:
        return S._file_slices(self, df=df, threshold=threshold, begin=begin, run=run)

    def timeline_stream(
        self,
        begin: float,
        end: float,
        width: int = 1200,
        summary: int = 1,
        lookback: float = 0,
        query: Optional[str] = None,
    ) -> Iterator[bytes]:
        return S.timeline_stream(
            self, begin=begin, end=end, width=width, summary=summary, lookback=lookback, query=query
        )

    def counters_arrow(
        self, begin: float, end: float, buckets: int = 400, query: Optional[str] = None
    ) -> bytes:
        return C.counters_arrow(self, begin=begin, end=end, buckets=buckets, query=query)

    def _counter_long(
        self,
        begin: float,
        end: float,
        query: Optional[str],
        extra: tuple[str, ...] = (),
        phase: str = "counters",
    ) -> DataFrame:
        return C._counter_long(self, begin=begin, end=end, query=query, extra=extra, phase=phase)

    def counter_series(
        self, begin: float, end: float, width: int = 800, query: Optional[str] = None
    ) -> SeriesPayload:
        return C.counter_series(self, begin=begin, end=end, width=width, query=query)

    def counter_split(
        self,
        begin: float,
        end: float,
        series_id: str,
        dim: str,
        width: int = 800,
        top: int = 32,
        query: Optional[str] = None,
    ) -> SplitPayload:
        return C.counter_split(
            self,
            begin=begin,
            end=end,
            series_id=series_id,
            dim=dim,
            width=width,
            top=top,
            query=query,
        )

    def pid_host_map(self) -> dict[str, str]:
        return C._pid_host_map(
            self,
        )

    def io_mask(self) -> "Expr":
        return self._io_name()

    def gap_limits(self) -> tuple[int, float, int]:
        return (self._GAP_MIN_US, self._GAP_MIN_FRAC, self._GAP_MAX_COUNT)

    def node_counters(self, begin: float, end: float, width: int = 800) -> NodeCountersPayload:
        return C.node_counters(self, begin=begin, end=end, width=width)

    def stats(
        self, begin: float, end: float, query: Optional[str] = None, group: str = "name"
    ) -> StatsPayload:
        w = _Window(begin, end, query)
        return self.one(w, Stats(group=group))

    _GAP_MIN_FRAC = 0.01
    _GAP_MIN_US = 50_000
    _GAP_MAX_COUNT = 40

    def breaks(self) -> BreaksPayload:
        m = self.info()
        total = m.global_max_ts - m.global_min_ts
        w = _Window(0, max(total, 0), APP_SPAN_QUERY)
        return self.one(w, Breaks())

    def histogram(
        self, begin: float, end: float, query: Optional[str] = None, nbuckets: int = 48
    ) -> HistogramPayload:
        w = _Window(begin, end, query)
        return self.one(w, Histogram(nbuckets=nbuckets))

    def size_histogram(
        self, begin: float, end: float, query: Optional[str] = None, nbuckets: int = 48
    ) -> SizeHistogramPayload:
        w = _Window(begin, end, query)
        return self.one(w, SizeHistogram(nbuckets=nbuckets))

    def op_stats(self, begin: float, end: float, query: Optional[str] = None) -> OpStatsPayload:
        return self.one(_Window(begin, end, query), OpStats())

    def proc_bytes(self, begin: float, end: float, query: Optional[str] = None) -> ProcBytesPayload:
        return self.one(_Window(begin, end, query), ProcBytes())

    def access_pattern(
        self, begin: float, end: float, query: Optional[str] = None
    ) -> AccessPatternPayload:
        return self.one(_Window(begin, end, query), AccessPattern())

    def calltree(
        self,
        begin: float,
        end: float,
        query: Optional[str] = None,
        by_process: bool = False,
        cap: int = 2_000_000,
    ) -> CalltreePayload:
        return T.calltree(self, begin, end, query, by_process)


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
