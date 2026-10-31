"""Provenance of traces that are still being written.

``provenance.build`` reads through the dftracer-utils index, which needs a finished
file: a trace with no complete gzip member yet is detected as a generic schema. A
DFTracer service writes its node trace as a sequence of independent gzip members and
seals one at least every flush interval, so this module reads the members directly.
``Tail`` commits its position only at the end of a whole member, because a member can be
unfinished, or missing for a moment before a later one.

``ProvFeed`` folds records into the same graph shape as ``provenance.build`` and keeps a
list of what each record added, which the API streams. An activity is written when it
ends, so an I/O call usually arrives before the activity holding it: it waits, and inner
activities, ending first, claim it first, which is the innermost-span rule of the batch
extractor.
"""

from __future__ import annotations

import glob
import json
import os
import threading
import zlib
from collections import Counter, deque
from typing import Any, Deque, Optional

from .provenance import _classify, _excluded

READ_LIMIT = 8 << 20
PENDING_IO = 200_000
ACTIVITY_CATS = ("moirai", "PROV")
IO_CATS = ("POSIX", "STDIO")
ACTIVITY_RELATIONS = ("used", "generated", "invalidated", "updated")
ROLES = ("unknown", "input", "output", "intermediate", "parameter", "reference")
STORES = (
    "memory",
    "gpu_memory",
    "local_disk",
    "parallel_fs",
    "burst_buffer",
    "object_store",
    "database",
    "network",
    "other",
)
RELATIONS = {
    16: "derived_from",
    17: "revision_of",
    18: "contains",
    19: "part_of",
    20: "specialization_of",
    21: "alternate_of",
    22: "depends_on",
}
KEEP_DELTAS = 50_000


def _named(names: tuple[str, ...], value: Any) -> str:
    return names[value] if isinstance(value, int) and 0 <= value < len(names) else str(value or "")


def expand(path: str) -> list[str]:
    """Every trace file under a directory, or a single file."""
    if os.path.isdir(path):
        return sorted(glob.glob(os.path.join(path, "**", "*.pfw.gz"), recursive=True))
    return [path] if os.path.isfile(path) else []


def has_whole_member(path: str, limit: int = READ_LIMIT) -> bool:
    """Whether a trace can be opened yet: the engine detects a file's schema from its head,
    so a file whose first gzip member is still being written reads as a generic trace, and
    the process keeps that answer."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(limit)
        d = zlib.decompressobj(zlib.MAX_WBITS | 16)
        d.decompress(data)
        return d.eof or len(data) >= limit
    except (OSError, zlib.error):
        return False


class Tail:
    """Incremental reader of the whole gzip members of a set of growing files."""

    def __init__(self, paths: list[str]) -> None:
        self.paths = paths
        self.pos: dict[str, int] = {}

    def poll(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for root in self.paths:
            for path in expand(root):
                out.extend(self._read(path))
        return out

    def _read(self, path: str) -> list[dict[str, Any]]:
        at = self.pos.get(path, 0)
        try:
            if os.path.getsize(path) <= at:
                return []
            with open(path, "rb") as fh:
                fh.seek(at)
                data = fh.read(READ_LIMIT)
        except OSError:
            return []
        records: list[dict[str, Any]] = []
        used = 0
        while used < len(data):
            d = zlib.decompressobj(zlib.MAX_WBITS | 16)
            try:
                text = d.decompress(data[used:])
            except zlib.error:
                break  # a hole: an earlier member is not written yet
            if not d.eof:
                break  # this member is still being written
            used = len(data) - len(d.unused_data)
            records.extend(_lines(text))
        self.pos[path] = at + used
        return records


def _lines(raw: bytes) -> list[dict[str, Any]]:
    out = []
    for line in raw.splitlines():
        line = line.strip().rstrip(b",")
        if line.startswith(b"{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


class ProvFeed:
    """The growing provenance graph of one run."""

    def __init__(self, paths: list[str]) -> None:
        self.tail = Tail(paths)
        self.lock = threading.Lock()
        self.seq = 0
        self.deltas: Deque[tuple[int, dict[str, Any]]] = deque(maxlen=KEEP_DELTAS)
        self.types: dict[str, dict[str, Any]] = {}
        self.entities: dict[str, dict[str, Any]] = {}
        self.activities: list[dict[str, Any]] = []
        self.relations: list[dict[str, Any]] = []
        self.files: dict[str, str] = {}
        self.access: dict[tuple[str, str, str], dict[str, int]] = {}
        self.records = 0
        self.other: Counter[str] = Counter()
        self._seen: set[Any] = set()
        self._sent: set[Any] = set()
        self._spans: dict[Any, list[tuple[int, int, str]]] = {}
        self._waiting: dict[Any, list[dict[str, Any]]] = {}

    def poll(self) -> int:
        """Read what is new; returns the number of graph changes."""
        records = self.tail.poll()
        with self.lock:
            before = self.seq
            for r in records:
                self._add(r)
            return self.seq - before

    def _emit(self, item: dict[str, Any]) -> None:
        self.seq += 1
        self.deltas.append((self.seq, item))

    def _add(self, r: dict[str, Any]) -> None:
        self.records += 1
        name, cat = r.get("name"), r.get("cat")
        a = r.get("args") or {}
        if name == "FH" and a.get("value"):
            self.files.setdefault(a["value"], a.get("name", ""))
            for key in [k for k in self.access if k[1] == a["value"]]:
                self._announce(key)
        elif name == "ET" and a.get("type") and a["type"] not in self.types:
            role = _named(ROLES, a.get("role", 0))
            self.types[a["type"]] = {
                "name": a["type"],
                "role": role,
                "description": a.get("description", ""),
            }
            self._emit({"kind": "type", **self.types[a["type"]]})
        elif name == "EH" and a.get("id"):
            self._entity(a, r)
        elif name == "ER" and a.get("subject"):
            key = (a.get("relation"), a["subject"], a.get("object"))
            if key not in self._seen:
                self._seen.add(key)
                rel = {
                    "relation": RELATIONS.get(a.get("relation"), str(a.get("relation"))),
                    "subject": a["subject"],
                    "object": a.get("object", ""),
                }
                self.relations.append(rel)
                self._emit({"kind": "relation", **rel})
        elif cat in ACTIVITY_CATS and r.get("ph") in (1, "X"):
            self._activity(r, a)
        elif cat in IO_CATS:
            self.other[cat] += 1
            if a.get("fhash"):
                self._io(r, a)
        elif cat and r.get("ph") not in (4, "M"):
            self.other[cat] += 1

    def _entity(self, a: dict[str, Any], r: dict[str, Any]) -> None:
        cur = self.entities.get(a["id"])
        if cur is not None:
            if r.get("pid") not in cur["pids"]:
                cur["pids"].append(r.get("pid"))
            return
        self.entities[a["id"]] = {
            "hash": a["id"],
            "id": a["id"],
            "type": a.get("type", ""),
            "store": _named(STORES, a.get("store", 8)),
            "uri": a.get("uri", ""),
            "pids": [r.get("pid")],
        }
        self._emit({"kind": "entity", **self.entities[a["id"]]})

    def _activity(self, r: dict[str, Any], a: dict[str, Any]) -> None:
        aid = f"{r.get('pid')}:{r.get('ts')}"
        if aid in self._seen:
            return
        self._seen.add(aid)
        rels = a.get("relations") or {}
        act = {
            "aid": aid,
            "name": r.get("name", ""),
            "activity": r.get("name", ""),
            "cat": r.get("cat", ""),
            "pid": r.get("pid"),
            "ts": r.get("ts") or 0,
            "dur": r.get("dur") or 0,
        }
        for key in ACTIVITY_RELATIONS:
            value = rels.get(key) or []
            act[key] = value if isinstance(value, list) else [value]
        self.activities.append(act)
        self._emit({"kind": "activity", **act})
        begin, end = act["ts"], act["ts"] + act["dur"]
        spans = self._spans.setdefault(r.get("pid"), [])
        spans.append((begin, end, aid))
        spans.sort()
        keep = []
        for call in self._waiting.get(r.get("pid"), []):
            if begin <= (call.get("ts") or 0) <= end:
                self._charge(aid, call, call.get("args") or {})
            else:
                keep.append(call)
        self._waiting[r.get("pid")] = keep

    def _io(self, r: dict[str, Any], a: dict[str, Any]) -> None:
        ts = r.get("ts") or 0
        for begin, end, aid in reversed(self._spans.get(r.get("pid"), [])[-256:]):
            if begin <= ts <= end:
                self._charge(aid, r, a)
                return
        waiting = self._waiting.setdefault(r.get("pid"), [])
        if len(waiting) < PENDING_IO:
            waiting.append(r)

    def _charge(self, aid: str, r: dict[str, Any], a: dict[str, Any]) -> None:
        name = r.get("name", "")
        op = _classify(name)
        ret, size = a.get("ret"), a.get("size")
        ret = ret if isinstance(ret, int) else 0
        size = size if name in ("fread", "fwrite") and isinstance(size, int) else 1
        got = self.access.setdefault((aid, a["fhash"], op), {"calls": 0, "bytes": 0})
        got["calls"] += int(a.get("dft_cnt") or 1)
        got["bytes"] += ret * size if op in ("read", "write") and ret > 0 else 0
        self._announce((aid, a["fhash"], op))

    def _announce(self, key: tuple[str, str, str]) -> None:
        path = self.files.get(key[1], "")
        if path and not _excluded(path) and key not in self._sent:
            self._sent.add(key)
            self._emit(
                {
                    "kind": "access",
                    "aid": key[0],
                    "fhash": key[1],
                    "path": path,
                    "op": key[2],
                    **self.access[key],
                }
            )

    def accesses(self) -> list[dict[str, Any]]:
        out = []
        for (aid, fhash, op), n in self.access.items():
            path = self.files.get(fhash, "")
            if path and not _excluded(path):
                out.append({"aid": aid, "fhash": fhash, "path": path, "op": op, **n})
        return out

    def snapshot(self) -> dict[str, Any]:
        """The graph so far, in the shape of ``/api/prov/graph``, with the position deltas
        continue from."""
        with self.lock:
            acc = self.accesses()
            paths = {x["path"]: x["fhash"] for x in acc}
            entity_files = []
            for e in self.entities.values():
                path = e["uri"][7:] if e["uri"].startswith("file://") else e["uri"]
                if path in paths:
                    entity_files.append({"entity": e["hash"], "fhash": paths[path], "path": path})
            return {
                "seq": self.seq,
                "types": list(self.types.values()),
                "entities": [dict(e) for e in self.entities.values()],
                "activities": list(self.activities),
                "entity_relations": list(self.relations),
                "accesses": acc,
                "entity_files": entity_files,
                "files": [{"fhash": h, "path": p, "mount": "", "rel": p} for p, h in paths.items()],
                "mounts": [],
                "stats": {
                    "entities": len(self.entities),
                    "activities": len(self.activities),
                    "records": self.records,
                },
            }

    def since(self, seq: int, limit: int = 2000) -> tuple[list[dict[str, Any]], int]:
        with self.lock:
            items = [i for s, i in self.deltas if s > seq][:limit]
            return items, seq + len(items)


def feed_for(cache: dict[str, ProvFeed], key: str, paths: list[str]) -> Optional[ProvFeed]:
    """The run's feed, created on first use, so every viewer of a run shares one reader."""
    if not paths:
        return None
    if key not in cache:
        cache[key] = ProvFeed(paths)
    return cache[key]
