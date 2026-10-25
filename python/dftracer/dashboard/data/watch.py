"""Watch a directory tree and turn it into a live set of trace runs.

A run is a directory that holds trace files, directly or inside a format
directory::

    <root>/
      <run>/raw/*.pfw.gz          original files, one per process
      <run>/compact/*.pfw.gz      ``dftracer_split`` output, always preferred

Files named ``*_chunk<N>.pfw.gz`` come from ``dftracer_split``: they hold the
same records as the raw files in fewer, larger chunks, so the two sets of one
run are alternatives and never read together.

Completion: a raw file ends with the ``end`` record the writer emits, so the
last record answers whether it is finished. A ``dftracer_split`` chunk is a
different matter: it holds the ``end`` records of its sources wherever they
land, so the last record proves nothing there. That last record is read straight
from the gzip tail (13 ms, writes nothing) instead of through ``TraceViewer``,
which would build an index (142 ms, 187 KB) for every file on every scan; the
engine is still the fallback when the tail cannot be parsed. Split chunks carry copies of the
``end`` records of their sources at arbitrary positions, so a compact set is
called done once nothing in it changed for ``settle_s``.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import re
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Optional, cast

if TYPE_CHECKING:
    from dftracer.utils import Runtime

from ..trace import TraceData, trace_data
from ..trace.frame import Row
from . import fsnotify
from .run_types import RunDict, Snapshot

log = logging.getLogger(__name__)

_COMPACT = re.compile(r"_chunk\d+\.pfw\.gz$")
_FORMAT_DIRS = frozenset({"raw", "raws", "compact", "split", "chunks", "merged", "traces"})
_GZIP_MAGIC = b"\x1f\x8b\x08"
# A producer-side "this set is finished" marker. dftracer writes none, so this
# is the only exact answer for a dftracer_split set; `--done-marker` adds names.
_MARKERS = ("_SUCCESS", ".done", "manifest.json", "split.json")
_TAIL_WINDOW = 32 * 1024 * 1024


def tail_record(path: str, window: int = _TAIL_WINDOW, tries: int = 16) -> Optional[Row]:
    """The last JSON record of a dftracer gzip file, without building an index.

    The writer cuts a member at the first line after ``write_buffer_size``
    bytes, so the last member is at most that big; searching the tail for the
    gzip magic and inflating from the last candidate that parses is enough.
    Returns None when the tail cannot be read as one record.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if not size:
        return None
    n = min(window, size)
    try:
        with open(path, "rb") as fh:
            fh.seek(size - n)
            buf = fh.read(n)
    except OSError:
        return None
    offsets: list[int] = []
    i = buf.rfind(_GZIP_MAGIC)
    while i >= 0 and len(offsets) < tries:
        offsets.append(i)
        i = buf.rfind(_GZIP_MAGIC, 0, i)
    if not offsets:
        offsets = [0]
    for start in offsets:
        try:
            d = zlib.decompressobj(31)
            text = (d.decompress(buf[start:]) + d.flush()).decode("utf-8", "replace")
        except zlib.error:
            continue
        lines = [x.strip().rstrip(",") for x in text.splitlines()]
        lines = [x for x in lines if x and x not in ("[", "]")]
        if not lines:
            continue
        try:
            rec = json.loads(lines[-1])
        except ValueError:
            continue
        if isinstance(rec, dict) and "name" in rec:
            return rec
    return None


_END_MARK = re.compile(rb'"name"\s*:\s*"end"')
_NUM_EVENTS = re.compile(rb'"num_events"\s*:\s*(\d+)')


def end_fingerprint(path: str) -> tuple[int, int]:
    """``(end records, sum of their num_events)`` in a whole trace file.

    dftracer_split copies the ``end`` record of every source file into some
    chunk, so this fingerprint of a compact set must equal the one of the raw
    set it was made from. A split still running falls short.

    Decompression and the search run in C: the records are only parsed where a
    ``"name":"end"`` marker was found, so cost is bytes-bound, not line-bound.
    """
    count = 0
    events = 0
    try:
        with gzip.open(path, "rb") as fh:
            data = fh.read()
    except (OSError, EOFError, zlib.error) as exc:
        log.debug("end fingerprint failed for %s: %s", path, exc)
        return (0, 0)
    for mark in _END_MARK.finditer(data):
        count += 1
        stop = data.find(b"\n", mark.end())
        if stop < 0:
            stop = len(data)
        hit = _NUM_EVENTS.search(data, mark.end(), stop)
        if hit is not None:
            events += int(hit.group(1))
    return (count, events)


@dataclass(frozen=True)
class TraceFile:
    path: str
    size: int
    mtime_ns: int
    events: int = 0  # num_events of the end record, when it is known

    @property
    def signature(self) -> tuple[str, int, int]:
        return (self.path, self.size, self.mtime_ns)


@dataclass
class CandidateSet:
    """One directory of trace files. Siblings are alternatives for a run."""

    dir: str
    files: list[str]
    compact: bool
    hinted: bool
    stats: dict[str, tuple[int, int]] = field(default_factory=dict)


@dataclass
class Run:
    id: str
    dir: str
    files: list[TraceFile]
    format: str  # "compact" | "raw"
    state: str  # "live" | "done" | "stalled"
    version: int = 1
    reason: str = ""  # "marker" | "end-record" | "quiet" | "writing"
    events: int = 0
    first_ts: int = 0
    last_ts: int = 0

    @property
    def bytes(self) -> int:
        return sum(f.size for f in self.files)

    def to_dict(self) -> RunDict:
        return RunDict(
            id=self.id,
            dir=self.dir,
            format=self.format,
            state=self.state,
            reason=self.reason,
            version=self.version,
            files=len(self.files),
            bytes=self.bytes,
            events=self.events,
            first_ts=self.first_ts,
            last_ts=self.last_ts,
        )


def _list_dir(directory: str) -> tuple[list[str], list[str]]:
    """Subdirectories and trace files of one directory, names only."""
    dirs: list[str] = []
    files: list[str] = []
    try:
        with os.scandir(directory) as entries:
            for e in entries:
                try:
                    if e.is_dir(follow_symlinks=False):
                        if not e.name.startswith("."):
                            dirs.append(e.path)
                    elif e.name.endswith(".pfw.gz"):
                        files.append(e.path)
                except OSError:
                    continue
    except OSError:
        pass
    return dirs, files


def _stat_batch(paths: list[str]) -> list[TraceFile]:
    out: list[TraceFile] = []
    for path in paths:
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append(TraceFile(path, st.st_size, st.st_mtime_ns))
    return out


def scan_sets(
    root: str,
    pool: Optional[ThreadPoolExecutor] = None,
    scan_workers: int = 32,
    batch: int = 256,
) -> list[CandidateSet]:
    """Every directory under ``root`` that holds trace files.

    On Lustre and NFS every ``stat`` is a round trip, so listings go one level
    at a time across a pool and stats are batched: cost becomes latency per
    batch instead of latency per file. The stats are handed on to the caller so
    a scan never stats the same file twice.
    """
    owned = pool is None
    ex = pool if pool is not None else ThreadPoolExecutor(max_workers=max(1, scan_workers))
    try:
        found: list[tuple[str, list[str]]] = []
        frontier = [root]
        while frontier:
            listed = list(ex.map(_list_dir, frontier))
            up_next: list[str] = []
            for directory, (dirs, files) in zip(frontier, listed):
                if files:
                    found.append((directory, files))
                up_next.extend(dirs)
            frontier = up_next
        tasks = []
        for _, files in found:
            for i in range(0, len(files), batch):
                tasks.append(ex.submit(_stat_batch, files[i : i + batch]))
        stats = [f.result() for f in tasks]
    finally:
        if owned:
            ex.shutdown(wait=False)

    stat_of: dict[str, TraceFile] = {}
    for chunk in stats:
        for tf in chunk:
            stat_of[tf.path] = tf
    out: list[CandidateSet] = []
    for directory, files in found:
        kept = [stat_of[p] for p in sorted(files) if p in stat_of]
        if not kept:
            continue
        name = os.path.basename(directory)
        compact = any(_COMPACT.search(f.path) for f in kept)
        out.append(
            CandidateSet(
                dir=directory,
                files=[f.path for f in kept],
                compact=compact,
                hinted=compact or name in _FORMAT_DIRS,
                stats={f.path: (f.size, f.mtime_ns) for f in kept},
            )
        )
    return out


def run_root(root: str, directory: str) -> str:
    """The run a candidate directory belongs to: format dirs collapse upwards."""
    parts = os.path.relpath(directory, root).split(os.sep)
    while len(parts) > 1 and parts[-1] in _FORMAT_DIRS:
        parts.pop()
    if parts == ["."]:
        return os.path.basename(os.path.abspath(root)) or "root"
    return os.sep.join(parts)


def group_runs(root: str, sets: list[CandidateSet]) -> dict[str, list[CandidateSet]]:
    groups: dict[str, list[CandidateSet]] = {}
    for s in sets:
        groups.setdefault(run_root(root, s.dir), []).append(s)
    return groups


def pick_set(group: list[CandidateSet]) -> CandidateSet:
    """Compact always wins; then a format-named dir; then the shallowest."""

    def score(s: CandidateSet) -> tuple[int, int, int, str]:
        return (0 if s.compact else 1, 0 if s.hinted else 1, s.dir.count(os.sep), s.dir)

    return min(group, key=score)


class RunRegistry:
    """The runs under a root, and one TraceData over their selected files."""

    def __init__(
        self,
        root: str,
        index_dir: str,
        runtime: Optional["Runtime"] = None,
        settle_s: float = 60.0,
        stale_s: float = 300.0,
        markers: Optional[list[str]] = None,
        verify_bytes: int = 512 * 1024 * 1024,
        fast_bytes: int = 64 * 1024 * 1024,
        quick_s: float = 2.0,
        scan_workers: int = 32,
        pool: Optional[ThreadPoolExecutor] = None,
    ) -> None:
        self.root = os.path.abspath(root)
        self.index_dir = index_dir
        self.runtime = runtime
        self.settle_s = settle_s
        self.stale_s = stale_s
        extra = [m for m in (markers or []) if m]
        self.markers = tuple(dict.fromkeys((*_MARKERS, *extra)))
        self.verify_bytes = verify_bytes
        self.fast_bytes = fast_bytes
        self.quick_s = quick_s
        self.scan_workers = max(1, scan_workers)
        self.check_cap = self.scan_workers * 8
        # A shared pool comes from runtime.pool; a standalone registry owns one.
        # Reported by /api/runs: "events" when the kernel delivers changes,
        # "poll" when the tree is on a filesystem that cannot.
        self.watch_mode = fsnotify.POLL
        self._owns_pool = pool is None
        self._pool = pool or ThreadPoolExecutor(
            max_workers=self.scan_workers, thread_name_prefix="dfd-scan"
        )
        self._lock = threading.RLock()
        self._runs: dict[str, Run] = {}
        self._sig: dict[str, tuple] = {}
        self._ends: dict[str, tuple[int, int, Optional[dict]]] = {}
        self._fps: dict[str, tuple[int, int]] = {}
        self._verify: dict[str, bool] = {}
        self._traces: dict[str, TraceData] = {}
        self._trace: Optional[TraceData] = None
        self._seq = 0
        self._listeners: list[Callable[[int], None]] = []

    @property
    def seq(self) -> int:
        return self._seq

    def add_listener(self, fn: Callable[[int], None]) -> Callable[[], None]:
        """Call ``fn(seq)`` after every change, from the scanning thread, so a
        caller that needs to run on an event loop must hop with
        ``loop.call_soon_threadsafe``. Returns the unsubscribe function."""
        with self._lock:
            self._listeners.append(fn)

        def drop() -> None:
            with self._lock:
                if fn in self._listeners:
                    self._listeners.remove(fn)

        return drop

    def runs(self) -> list[Run]:
        with self._lock:
            return sorted(self._runs.values(), key=lambda r: r.id)

    def run_ids(self) -> list[str]:
        return [r.id for r in self.runs()]

    def files(self) -> list[str]:
        return [f.path for run in self.runs() for f in run.files]

    def n_files(self) -> int:
        return len(self.files())

    def n_files_for(self, run_id: str) -> int:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                raise KeyError(run_id)
            return len(run.files)

    def _engine_has_end(self, path: str) -> bool:
        """Authoritative check through the trace engine, which builds an index."""
        from dftracer.utils import Series, TraceViewer

        try:
            frame = TraceViewer(path, index_path=self.index_dir).select(["name"]).collect()
            names = cast(Series, frame["name"]).to_list()
            return "end" in names
        except Exception as exc:
            log.debug("end-record check failed for %s: %s", path, exc)
            return False

    def _run_dir(self, run_id: str, chosen: CandidateSet) -> str:
        """The run directory a marker belongs in, which is above the format dir."""
        if os.path.abspath(chosen.dir) == os.path.abspath(os.path.join(self.root, run_id)):
            return chosen.dir
        return os.path.abspath(os.path.join(self.root, run_id))

    def _prefetch(self, files: list[TraceFile]) -> None:
        """Read the tail of the files that need it, in parallel and capped.

        A tick must cost the same whether a run holds 30 files or 30 000, so at
        most ``check_cap`` new files are read per scan. Anything not read yet
        counts as unfinished, which only delays a "done" badge.
        """
        todo = [f for f in files if not self._cached_end(f)][: self.check_cap]
        if not todo:
            return
        list(self._pool.map(self._remember_end, todo))

    def _cached_end(self, f: TraceFile) -> bool:
        hit = self._ends.get(f.path)
        return bool(hit and hit[0] == f.size and hit[1] == f.mtime_ns)

    def _remember_end(self, f: TraceFile) -> None:
        rec = tail_record(f.path)
        if rec is None:
            # The peek could not read the tail: the engine is the authority,
            # and this is the only place it is asked, once per file version.
            rec = {"name": "end"} if self._engine_has_end(f.path) else {"name": ""}
        self._ends[f.path] = (f.size, f.mtime_ns, rec)

    def _complete(self, f: TraceFile) -> bool:
        """Answer from the prefetch cache only, so a tick stays bounded."""
        hit = self._ends.get(f.path)
        if hit is None or hit[0] != f.size or hit[1] != f.mtime_ns:
            return False
        rec = hit[2]
        return bool(rec and rec.get("name") == "end")

    def _end_record(self, f: TraceFile) -> Optional[dict]:
        """Cached tail record, read on demand. Used for the writer's counts."""
        hit = self._ends.get(f.path)
        if hit and hit[0] == f.size and hit[1] == f.mtime_ns:
            rec = hit[2]
        else:
            rec = tail_record(f.path)
            self._ends[f.path] = (f.size, f.mtime_ns, rec)
        return rec

    def _marked(self, *dirs: str) -> bool:
        return any(os.path.exists(os.path.join(d, m)) for d in dirs if d for m in self.markers)

    def _raw_files(self, raw: CandidateSet) -> list[TraceFile]:
        out = []
        for p in raw.files:
            known = raw.stats.get(p)
            if known is not None:
                size, mtime = known
            else:
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                size, mtime = st.st_size, st.st_mtime_ns
            f = TraceFile(p, size, mtime)
            rec = self._end_record(f)
            args = (rec or {}).get("args") or {}
            out.append(TraceFile(p, size, mtime, int(args.get("num_events") or 0)))
        return out

    def _fingerprint(self, files: list[TraceFile], key: str) -> tuple[int, int]:
        hit = self._fps.get(key)
        if hit is not None:
            return hit
        parts = list(self._pool.map(end_fingerprint, [f.path for f in files]))
        fp = (sum(p[0] for p in parts), sum(p[1] for p in parts))
        self._fps[key] = fp
        return fp

    def _state(
        self,
        run_id: str,
        files: list[TraceFile],
        mode: str,
        now: float,
        chosen: CandidateSet,
        raw: Optional[CandidateSet],
    ) -> tuple[str, str]:
        """State and the reason for it, so the UI never has to guess.

        Nothing here reads file contents while the set is still being written:
        a file that changed within ``quick_s`` is assumed unfinished, which is
        what makes a scan cost stat calls only.
        """
        if not files:
            return "stalled", "writing"
        if self._marked(chosen.dir, self._run_dir(run_id, chosen)):
            return "done", "marker"
        idle = now - max(f.mtime_ns for f in files) / 1e9
        settled = idle >= self.settle_s
        if mode == "raw" and (settled or idle >= self.quick_s):
            self._prefetch(files)
        if mode == "raw":
            if not settled and idle < self.quick_s:
                return "live", "writing"
            if all(self._complete(f) for f in files):
                return "done", "end-record"
            return ("stalled" if idle >= self.stale_s else "live"), "writing"
        # Compact: compare the end records dftracer_split copied against the raw
        # set it was made from. Equal means every source record arrived. The
        # pass is cached by signature, so it costs one read per finished set.
        if raw is not None:
            src = self._raw_files(raw)
            if src:
                # The raw set is the record of truth: if it has no end record
                # yet the split cannot be finished either, quiet or not.
                self._prefetch(src)
                if not all(self._complete(f) for f in src):
                    return ("stalled" if idle >= self.stale_s else "live"), "writing"
                cheap = sum(f.size for f in files) <= self.fast_bytes
                if settled or (idle >= self.quick_s and cheap):
                    total = sum(f.size for f in files)
                    if total <= self.verify_bytes:
                        key = f"{run_id}:{','.join(f'{f.size}@{f.mtime_ns}' for f in files)}"
                        got = self._fingerprint(files, key)
                        want = (len(src), sum(f.events for f in src))
                        if got == want:
                            return "done", "verified"
                        return "live", "writing"
        if settled:
            return "done", "quiet"
        return ("stalled", "writing") if idle >= self.stale_s else ("live", "writing")

    def refresh(self) -> bool:
        """Rescan the tree. Returns True when anything changed."""
        now = time.time()
        sets = scan_sets(self.root, pool=self._pool, scan_workers=self.scan_workers)
        groups = group_runs(self.root, sets)
        changed = False
        seen: set[str] = set()
        with self._lock:
            for run_id, group in groups.items():
                chosen = pick_set(group)
                files = []
                for p in chosen.files:
                    known = chosen.stats.get(p)
                    if known is not None:
                        files.append(TraceFile(p, known[0], known[1]))
                        continue
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    files.append(TraceFile(p, st.st_size, st.st_mtime_ns))
                if not files:
                    continue
                mode = "compact" if chosen.compact else "raw"
                raw = next((c for c in group if not c.compact), None)
                sig = (chosen.dir, mode, tuple(f.signature for f in files))
                prev = self._runs.get(run_id)
                # State is recomputed every scan even when the file set is
                # unchanged: completion is proven a batch at a time, so a run
                # becomes "done" a few ticks after its last write.
                state, reason = self._state(run_id, files, mode, now, chosen, raw)
                seen.add(run_id)
                if prev is not None and self._sig.get(run_id) == sig:
                    if (prev.state, prev.reason) != (state, reason):
                        prev.state, prev.reason = state, reason
                        prev.version += 1
                        changed = True
                    continue
                run = Run(
                    id=run_id,
                    dir=chosen.dir,
                    files=files,
                    format=mode,
                    state=state,
                    reason=reason,
                    version=1 if prev is None else prev.version + 1,
                )
                run.events = prev.events if prev and prev.events else 0
                run.first_ts = prev.first_ts if prev else 0
                run.last_ts = prev.last_ts if prev else 0
                self._runs[run_id] = run
                self._sig[run_id] = sig
                self._traces.pop(run_id, None)
                changed = True
            for gone in set(self._runs) - seen:
                del self._runs[gone]
                self._sig.pop(gone, None)
                self._traces.pop(gone, None)
                changed = True
            if changed:
                self._seq += 1
                self._trace = None
            seq = self._seq
            listeners = list(self._listeners) if changed else []
        for fn in listeners:
            try:
                fn(seq)
            except Exception:
                log.exception("trace change listener failed")
        return changed

    def close(self) -> None:
        if self._owns_pool:
            self._pool.shutdown(wait=False)

    def order(self) -> list[str]:
        """Run ids in band order: by first timestamp, unknown starts last."""
        with self._lock:
            return [
                r.id
                for r in sorted(
                    self._runs.values(),
                    key=lambda r: (r.first_ts or float("inf"), r.id),
                )
            ]

    def _file_runs(self, trace: TraceData) -> TraceData:
        index = {run_id: i for i, run_id in enumerate(self.order())}
        mapping: dict[str, int] = {}
        with self._lock:
            for run_id, run in self._runs.items():
                slot = index.get(run_id, -1)
                for f in run.files:
                    mapping[f.path] = slot
        trace.file_runs = mapping
        return trace

    def _source(self, run: "Run") -> Optional[str]:
        """The run's directory when its selected files are exactly that
        directory's traces, so one viewer can cover them; None otherwise."""
        if not os.path.isdir(run.dir):
            return None
        try:
            present = {
                os.path.join(run.dir, name)
                for name in os.listdir(run.dir)
                if name.endswith(".pfw.gz")
            }
        except OSError:
            return None
        selected = {f.path for f in run.files}
        return run.dir if present == selected else None

    def trace(self) -> Optional[TraceData]:
        with self._lock:
            if self._trace is None:
                files = self.files()
                if not files:
                    return None
                runs = list(self._runs.values())
                source = self._source(runs[0]) if len(runs) == 1 and runs else None
                self._trace = trace_data(
                    files, index_dir=self.index_dir, runtime=self.runtime, source=source
                )
            return self._file_runs(self._trace)

    def trace_for(self, run_id: str) -> TraceData:
        with self._lock:
            if run_id not in self._runs:
                raise KeyError(run_id)
            trace = self._traces.get(run_id)
            if trace is None:
                run = self._runs[run_id]
                trace = trace_data(
                    [f.path for f in run.files],
                    index_dir=self.index_dir,
                    runtime=self.runtime,
                    source=self._source(run),
                )
                self._traces[run_id] = self._file_runs(trace)
            return trace

    def describe(self, run_id: str) -> RunDict:
        """A run plus its time range, which costs one metadata pass."""
        run = self._runs.get(run_id)
        if run is None:
            raise KeyError(run_id)
        out = run.to_dict()
        try:
            info = self.trace_for(run_id).info()
        except Exception as exc:  # a file still being written can fail to parse
            log.warning("cannot read run %s: %s", run_id, exc)
            return out
        # Keep the last good numbers: a later failed read must not report 0.
        run.events = info.num_events
        run.first_ts = info.global_min_ts
        run.last_ts = info.global_max_ts
        out.update(events=run.events, first_ts=run.first_ts, last_ts=run.last_ts)
        return out

    def snapshot(self) -> Snapshot:
        ids = self.order()
        return Snapshot(
            root=self.root,
            watch=self.watch_mode,
            seq=self._seq,
            runs=[self.describe(r) for r in ids],
        )


class Watcher(threading.Thread):
    """Polls the registry and reports changes through ``on_change``."""

    def __init__(
        self,
        registry: RunRegistry,
        interval: float = 2.0,
        on_change: Optional[Callable[[], None]] = None,
        use_events: bool = True,
    ) -> None:
        super().__init__(name="dfdashboard-watch", daemon=True)
        self.registry = registry
        self.interval = max(0.2, interval)
        self.safety = max(30.0, self.interval * 10)  # poll floor under inotify
        self._on_change = on_change
        self._use_events = use_events
        self._halt = threading.Event()  # not _stop: Thread owns that name
        self._wake = threading.Event()
        self._ino: Optional[fsnotify.Inotify] = None

    def _choose(self) -> str:
        if not self._use_events:
            return fsnotify.POLL
        return fsnotify.strategy(self.registry.root)

    def run(self) -> None:
        mode = self._choose()
        if mode == fsnotify.EVENTS:
            self._ino = fsnotify.Inotify(self.registry.root, self._wake.set)
            if not self._ino.start():
                log.warning("inotify unavailable on %s, polling instead", self.registry.root)
                self._ino = None
                mode = fsnotify.POLL
        self.registry.watch_mode = mode
        log.info(
            "watching %s by %s (interval %.1fs, safety %.0fs)",
            self.registry.root,
            mode,
            self.interval,
            self.safety if mode == fsnotify.EVENTS else self.interval,
        )
        timeout = self.safety if mode == fsnotify.EVENTS else self.interval
        while not self._halt.is_set():
            self._wake.wait(timeout)
            self._wake.clear()
            if self._halt.is_set():
                break
            try:
                if self.registry.refresh() and self._on_change is not None:
                    self._on_change()
            except Exception:
                log.exception("trace scan failed")
        if self._ino is not None:
            self._ino.stop()

    def stop(self) -> None:
        self._halt.set()
        self._wake.set()  # do not wait out the safety interval
