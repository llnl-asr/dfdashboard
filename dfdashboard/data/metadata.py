"""Persisted trace metadata: cache the info() scan keyed by the trace files'
size+mtime, so only the first run (or a changed trace) pays for it."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TraceMeta:
    """All state info() derives from a full scan; also the cache payload."""

    global_min_ts: int = 0
    global_max_ts: int = 0
    num_events: int = 0
    total_bytes: int = 0
    total_io_busy: int = 0
    io_share: float = 0.0
    # Absolute [min_ts, max_ts] per reader (None if empty), for windowed-read pruning.
    bounds: list[Optional[tuple[int, int]]] = field(default_factory=list)
    pids: list[int] = field(default_factory=list)
    proc: dict[int, list[int]] = field(default_factory=dict)  # pid -> [bytes, ops, busy_us]
    layers: dict[str, str] = field(default_factory=dict)
    file_count: int = 0
    io_file_count: int = 0
    hosts: dict[int, str] = field(default_factory=dict)  # pid -> hostname
    ranks: dict[int, str] = field(default_factory=dict)  # pid -> MPI/process rank


class MetadataCache:
    def __init__(self, index_dir: str, paths: list[str]) -> None:
        self._index_dir = index_dir
        self._paths = paths

    @property
    def key(self) -> str:
        # Identifies the trace's current bytes; changes if any file changes.
        h = hashlib.sha256()
        for p in sorted(self._paths):
            try:
                st = os.stat(p)
                h.update(f"{p}:{st.st_size}:{st.st_mtime_ns}".encode())
            except OSError:
                h.update(f"{p}:missing".encode())
        return h.hexdigest()[:16]

    def _path(self) -> Optional[str]:
        if not self._index_dir:
            return None
        return os.path.join(self._index_dir, f"dfdashboard-meta-{self.key}.json")

    def load(self, n_readers: int) -> Optional[TraceMeta]:
        path = self._path()
        if not path or not os.path.exists(path):
            return None
        try:
            with open(path) as f:
                c = json.load(f)
            if len(c.get("bounds", [])) != n_readers:
                return None
            return TraceMeta(
                global_min_ts=c["global_min_ts"],
                global_max_ts=c["global_max_ts"],
                num_events=c["num_events"],
                total_bytes=c["total_bytes"],
                total_io_busy=c["total_io_busy"],
                io_share=c["io_share"],
                bounds=[tuple(b) if b else None for b in c["bounds"]],
                pids=c["pids"],
                proc={int(k): v for k, v in c["proc"].items()},
                layers=c["layers"],
                file_count=c["file_count"],
                io_file_count=c["io_file_count"],
                hosts={int(k): v for k, v in c.get("hosts", {}).items()},
                ranks={int(k): v for k, v in c.get("ranks", {}).items()},
            )
        except (OSError, ValueError, KeyError, TypeError):
            return None  # corrupt or old-format cache -> rescan and rewrite

    def save(self, meta: TraceMeta) -> None:
        path = self._path()
        if not path:
            return
        try:
            os.makedirs(self._index_dir, exist_ok=True)
            tmp = f"{path}.{os.getpid()}.tmp"
            with open(tmp, "w") as f:
                json.dump(
                    {
                        "global_min_ts": meta.global_min_ts,
                        "global_max_ts": meta.global_max_ts,
                        "num_events": meta.num_events,
                        "total_bytes": meta.total_bytes,
                        "total_io_busy": meta.total_io_busy,
                        "io_share": meta.io_share,
                        "bounds": [list(b) if b else None for b in meta.bounds],
                        "pids": meta.pids,
                        "proc": {str(k): v for k, v in meta.proc.items()},
                        "layers": meta.layers,
                        "file_count": meta.file_count,
                        "io_file_count": meta.io_file_count,
                        "hosts": {str(k): v for k, v in meta.hosts.items()},
                        "ranks": {str(k): v for k, v in meta.ranks.items()},
                    },
                    f,
                )
            os.replace(tmp, path)
        except OSError:
            pass  # best-effort
