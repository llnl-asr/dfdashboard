"""Provenance graph extraction, ported from dftracer-utils.

Mirrors ``trace::provenance::extract_provenance_graph`` in dftracer-utils
(src/dftracer/utils/trace/provenance/provenance_graph.cpp, MIT): the record
layout, the entity/activity folding, the I/O attribution window and the JSON
shape are that implementation's contract with ``web/src/prov``.

Two record layouts exist and both are read:

* the entity API: ``EH`` / ``ET`` / ``ER`` records, and ``used`` / ``generated``
  / ``invalidated`` / ``updated`` arrays on any event;
* the legacy producer: metadata ``args.name = "prov_entity:<hash>"`` and
  ``prov_type:<type>``, plus ``cat == "PROV"`` / ``"PROV_CONT"`` events carrying
  ``prov_aid`` and comma-separated ``prov_used`` / ``prov_generated``.

The index flattens array args into one column per element (``args.used.0``), so
a row's list is the row's non-null elements in index order.

One difference from the C++ extractor: an entity declared in several files with
different URIs keeps the first one scanned. The C++ keeps whichever its parallel
slots merge first, so that value is not stable there either.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import TYPE_CHECKING, Any, Iterator, Optional, cast

if TYPE_CHECKING:
    from dftracer.utils import DataFrame

    from .trace import TraceData

_ENTITY_PREFIX = "prov_entity:"
_TYPE_PREFIX = "prov_type:"
_RELATIONS = ("used", "generated", "invalidated", "updated")

_STORES = (
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
_ROLES = ("unknown", "input", "output", "intermediate", "parameter", "reference")
_RELATION_NAMES = {
    16: "derived_from",
    17: "revision_of",
    18: "contains",
    19: "part_of",
    20: "specialization_of",
    21: "alternate_of",
    22: "depends_on",
}

_READS = frozenset(
    "read pread pread64 readv preadv fread fgets fgetc getc getline fscanf mmap mmap64".split()
)
_WRITES = frozenset(
    "write pwrite pwrite64 writev pwritev fwrite fputs fputc putc fprintf "
    "ftruncate truncate".split()
)
_OPENS = frozenset("open open64 openat openat64 creat creat64 fopen fopen64 fdopen freopen".split())
_DELETES = frozenset("unlink unlinkat remove rmdir".split())

_EXCLUDED_SUFFIXES = (".py", ".pyc", ".pyi", ".so", ".pth", ".typed")
_EXCLUDED_PARTS = (
    "/site-packages/",
    "/dist-packages/",
    "/__pycache__/",
    ".so.",
    "/lib/python",
    "/.cache/",
    "/comgr-",
    "/cache/",
    "/triton/",
    "/dace/",
    "openmm.cache",
    "/cppattn_cache",
)
_EXCLUDED_PREFIXES = (
    "/proc/",
    "/sys/",
    "/dev/",
    "/etc/",
    "/usr/lib",
    "/usr/share/",
    "/lib/",
    "/lib64/",
    "/opt/rocm",
    "/opt/cray/",
    "/collab/usr/",
)
_PSEUDO_FSTYPES = frozenset(
    "proc sysfs cgroup cgroup2 devpts securityfs debugfs tracefs configfs pstore bpf "
    "mqueue hugetlbfs autofs fusectl binfmt_misc rpc_pipefs devtmpfs efivarfs rootfs".split()
)

_RELATION_KEY = re.compile(rf"^(relations\.)?({'|'.join(_RELATIONS)})\.(\d+)$")


def _named(names: tuple[str, ...], value: Any, default: str) -> str:
    """A numeric enum as its name; an already-named value passes through."""
    text = str(value) if value is not None else ""
    if not text:
        return default
    if not re.fullmatch(r"-?\d+", text):
        return text
    index = int(text)
    return names[index] if 0 <= index < len(names) else names[-1]


def _relation_name(value: Any) -> str:
    text = str(value) if value is not None else ""
    try:
        return _RELATION_NAMES.get(int(text), "related")
    except ValueError:
        return text or "related"


def _split_hashes(text: Any) -> list[str]:
    if not text:
        return []
    return [part for part in str(text).split(",") if part]


def _classify(name: str) -> str:
    if name in _READS:
        return "read"
    if name in _WRITES:
        return "write"
    if name in _OPENS:
        return "open"
    if name in _DELETES:
        return "delete"
    return "meta"


def _excluded(path: str) -> bool:
    if not path or not path.startswith("/"):
        return True
    if any(path.endswith(s) for s in _EXCLUDED_SUFFIXES):
        return True
    if any(part in path for part in _EXCLUDED_PARTS):
        return True
    if path.startswith("/dev/shm/"):
        return False
    if any(path.startswith(p) for p in _EXCLUDED_PREFIXES):
        return True
    return path == "/dev/null"


def _host_mounts(extra: tuple[str, ...]) -> list[dict[str, str]]:
    table: list[dict[str, str]] = []
    for mount in extra:
        path = mount.rstrip("/") or "/"
        if mount:
            table.append({"path": path, "fstype": "user"})
    try:
        with open("/proc/self/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3 or parts[1] == "/" or parts[2] in _PSEUDO_FSTYPES:
                    continue
                table.append({"path": _unescape_mount(parts[1]), "fstype": parts[2]})
    except OSError:
        pass
    return table


def _unescape_mount(path: str) -> str:
    def repl(m: re.Match[str]) -> str:
        return chr(int(m.group(1), 8))

    return re.sub(r"\\([0-7]{3})", repl, path)


def _split_mount(path: str, table: list[dict[str, str]]) -> tuple[str, str]:
    best = ""
    for mount in table:
        m = mount["path"]
        if len(m) <= 1:
            continue
        if path == m or (path.startswith(m) and path[len(m) : len(m) + 1] == "/"):
            if len(m) > len(best):
                best = m

    def rel_of(n: int) -> str:
        return "." if n >= len(path) else path[n + 1 :]

    if best:
        return best, rel_of(len(best))
    if path.startswith("/mnt/nnf/"):
        end = path.find("/", 9)
        m = path if end == -1 else path[:end]
        return m, rel_of(len(m))
    n = 0
    for _ in range(2):
        end = path.find("/", n + 1)
        if end == -1:
            return path, "."
        n = end
    return path[:n], rel_of(n)


def _arg_names(trace: "TraceData") -> tuple[str, ...]:
    """Index arg keys the provenance layouts use, as engine column names."""
    fixed = (
        "id",
        "type",
        "store",
        "uri",
        "relation",
        "subject",
        "object",
        "role",
        "description",
        "value",
        "name",
        "activity",
        "prov_aid",
        "prov_activity",
        "prov_used",
        "prov_generated",
        "prov_nused",
        "prov_ngen",
    )
    cols = [f"args.{k}" for k in fixed]
    cols += [f"args.{k}" for k in trace.columns() if _RELATION_KEY.match(k)]
    return tuple(cols)


def _relation_columns(trace: "TraceData") -> list[tuple[str, str, int]]:
    """(engine column, relation, element index) for every relation array cell."""
    out: list[tuple[str, str, int]] = []
    for key in trace.columns():
        m = _RELATION_KEY.match(key)
        if m:
            out.append((f"args.{key}", m.group(2), int(m.group(3))))
    return out


def _list_of(row: dict[str, Any], prefix: str, rel: str) -> list[str]:
    cells: list[tuple[int, str]] = []
    for k, v in row.items():
        if v is None:
            continue
        idx = _cell_key(k, prefix, rel)
        if idx is not None:
            cells.append((idx, str(v)))
    cells.sort()
    return [v for _, v in cells]


def _cell_key(column: str, prefix: str, rel: str) -> Optional[int]:
    if prefix == "":
        head = f"args.{rel}."
    else:
        head = f"args.{prefix}{rel}."
    if not column.startswith(head):
        return None
    tail = column[len(head) :]
    return int(tail) if tail.isdigit() else None


def _add_pid(pids: list[int], pid: int) -> None:
    if pid not in pids:
        pids.append(pid)


def _field(row: dict[str, Any], key: str, idx: int) -> str:
    """A structured field, else the ``|``-separated legacy value at ``idx``."""
    value = row.get(f"args.{key}")
    if value is not None:
        return str(value)
    if idx < 0:
        return ""
    parts = str(row.get("args.value") or "").split("|")
    return parts[idx] if idx < len(parts) else ""


def _ingest(acc: dict[str, Any], row: dict[str, Any]) -> None:
    stats = acc["stats"]
    pid = int(row.get("pid") or 0)
    cat = str(row.get("cat") or "")
    name = str(row.get("name") or "")
    args_name = str(row.get("args.name") or "")

    if name == "EH":
        stats["entity_records"] += 1
        eid = _field(row, "id", -1) or args_name
        if not eid:
            return
        entity = acc["entities"].get(eid)
        if entity is None:
            entity = acc["entities"][eid] = {
                "hash": eid,
                "type": _field(row, "type", 0),
                "id": eid,
                "store": _named(_STORES, _field(row, "store", 1), "memory"),
                "uri": _field(row, "uri", 2),
                "pids": [],
            }
        _add_pid(cast("list[int]", entity["pids"]), pid)
        return

    if name == "ET":
        tname = _field(row, "type", -1) or args_name
        if not tname or tname in acc["types"]:
            return
        acc["types"][tname] = {
            "name": tname,
            "role": _named(_ROLES, _field(row, "role", 0), "unknown"),
            "description": _field(row, "description", 1),
        }
        return

    if name == "ER":
        rel = _field(row, "relation", -1) or args_name
        subject = _field(row, "subject", 0)
        obj = _field(row, "object", 1)
        if subject and obj:
            acc["entity_relations"].append(
                {
                    "relation": _relation_name(rel),
                    "subject": subject,
                    "object": obj,
                }
            )
        return

    used = _list_of(row, "", "used") + _list_of(row, "relations.", "used")
    generated = _list_of(row, "", "generated") + _list_of(row, "relations.", "generated")
    invalidated = _list_of(row, "", "invalidated") + _list_of(row, "relations.", "invalidated")
    updated = _list_of(row, "", "updated") + _list_of(row, "relations.", "updated")
    if used or generated or invalidated or updated:
        stats["prov_events"] += 1
        aid = f"{pid}:{int(row.get('id') or 0)}:{int(row.get('ts') or 0)}"
        activity = acc["activities"].setdefault(aid, _new_activity(aid))
        activity["has_main"] = True
        activity["name"] = name
        activity["cat"] = cat
        activity["activity"] = str(row.get("args.activity") or cat)
        activity["pid"] = pid
        activity["ts"] = int(row.get("ts") or 0)
        activity["dur"] = int(row.get("dur") or 0)
        activity["used"] = used
        activity["generated"] = generated
        activity["invalidated"] = invalidated
        activity["updated"] = updated
        return

    if cat not in ("PROV", "PROV_CONT"):
        return
    aid = str(row.get("args.prov_aid") or "")
    if not aid:
        return
    activity = acc["activities"].setdefault(aid, _new_activity(aid))
    activity["used"] += _split_hashes(row.get("args.prov_used"))
    activity["generated"] += _split_hashes(row.get("args.prov_generated"))
    if cat == "PROV_CONT":
        stats["cont_events"] += 1
        return
    stats["prov_events"] += 1
    activity["has_main"] = True
    activity["name"] = name
    activity["activity"] = str(row.get("args.prov_activity") or "")
    activity["pid"] = pid
    activity["ts"] = int(row.get("ts") or 0)
    activity["dur"] = int(row.get("dur") or 0)
    activity["nused"] = _int(row.get("args.prov_nused"), -1)
    activity["ngen"] = _int(row.get("args.prov_ngen"), -1)


def _ingest_legacy_meta(acc: dict[str, Any], row: dict[str, Any]) -> None:
    """prov_entity/prov_type metadata; EH/ET/ER rows are handled by the scan."""
    args_name = str(row.get("args.name") or "")
    pid = int(row.get("pid") or 0)
    if args_name.startswith(_TYPE_PREFIX):
        tname = args_name[len(_TYPE_PREFIX) :]
        if tname and tname not in acc["types"]:
            value = str(row.get("args.value") or "")
            role, bar, description = value.partition("|")
            acc["types"][tname] = {
                "name": tname,
                "role": role if bar else "",
                "description": description if bar else value,
            }
        return
    if not args_name.startswith(_ENTITY_PREFIX):
        return
    acc["stats"]["entity_records"] += 1
    h = args_name[len(_ENTITY_PREFIX) :]
    entity = acc["entities"].get(h)
    if entity is None:
        parts = (str(row.get("args.value") or "").split("|") + ["", "", "", ""])[:4]
        entity = acc["entities"][h] = {
            "hash": h,
            "type": parts[0],
            "id": parts[1],
            "store": parts[2] or "memory",
            "uri": parts[3],
            "pids": [],
        }
    _add_pid(cast("list[int]", entity["pids"]), pid)


def _new_activity(aid: str) -> dict[str, Any]:
    return {
        "aid": aid,
        "name": "",
        "activity": "",
        "pid": 0,
        "ts": 0,
        "dur": 0,
        "used": [],
        "generated": [],
        "invalidated": [],
        "updated": [],
        "cat": "",
        "nused": -1,
        "ngen": -1,
        "has_main": False,
    }


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _finish(acc: dict[str, Any]) -> dict[str, Any]:
    stats = acc["stats"]
    referenced: dict[str, None] = {}
    for rel in acc["entity_relations"]:
        referenced[rel["subject"]] = None
        referenced[rel["object"]] = None

    for activity in acc["activities"].values():
        if not activity["has_main"]:
            stats["orphan_chunks"] += 1
        if (activity["nused"] >= 0 and activity["nused"] != len(activity["used"])) or (
            activity["ngen"] >= 0 and activity["ngen"] != len(activity["generated"])
        ):
            stats["truncated_activities"] += 1
        for key in _RELATIONS:
            for h in activity[key]:
                referenced[h] = None

    for h in acc["entities"]:
        if h not in referenced:
            stats["isolated_entities"] += 1
    for h in referenced:
        if h not in acc["entities"]:
            stats["dangling_hashes"] += 1

    types = sorted(acc["types"].values(), key=lambda t: t["name"])
    for entity in acc["entities"].values():
        entity["pids"].sort()
    entities = sorted(acc["entities"].values(), key=lambda e: (e["type"], e["id"]))
    activities = sorted(acc["activities"].values(), key=lambda a: (a["ts"], a["aid"]))
    for activity in activities:
        activity.pop("has_main", None)
        activity.pop("nused", None)
        activity.pop("ngen", None)
    return {
        "entities": entities,
        "entity_relations": acc["entity_relations"],
        "types": types,
        "activities": activities,
        "files": [],
        "mounts": [],
        "accesses": [],
        "entity_files": [],
        "stats": {
            "entities": len(entities),
            "activities": len(activities),
            "entity_records": stats["entity_records"],
            "prov_events": stats["prov_events"],
            "cont_events": stats["cont_events"],
            "dangling_hashes": stats["dangling_hashes"],
            "isolated_entities": stats["isolated_entities"],
            "truncated_activities": stats["truncated_activities"],
            "orphan_chunks": stats["orphan_chunks"],
            "files": 0,
            "mounts": 0,
            "io_events": 0,
            "io_attributed": 0,
            "files_excluded": 0,
        },
    }


def _span_index(activities: list[dict[str, Any]]) -> dict[int, list[tuple[int, int, str]]]:
    spans: dict[int, list[tuple[int, int, str]]] = defaultdict(list)
    for a in activities:
        spans[a["pid"]].append((a["ts"], a["ts"] + a["dur"], a["aid"]))
    for v in spans.values():
        v.sort()
    return spans


def _find_span(spans: dict[int, list[tuple[int, int, str]]], pid: int, ts: int) -> Optional[str]:
    lane = spans.get(pid)
    if not lane:
        return None
    lo, hi = 0, len(lane)
    while lo < hi:
        mid = (lo + hi) // 2
        if lane[mid][0] <= ts:
            lo = mid + 1
        else:
            hi = mid
    index = lo - 1
    for _ in range(256):
        if index < 0:
            return None
        begin, end, aid = lane[index]
        if end >= ts:
            return aid
        index -= 1
    return None


def _io_columns(trace: "TraceData") -> tuple[str, ...]:
    _ = trace
    return (
        "name",
        "cat",
        "pid",
        "ts",
        "args.fhash",
        "args.ret",
        "args.size",
        "args.newpath_hash",
        "args.cwd",
        "args.name",
        "args.value",
    )


def build(
    trace: "TraceData",
    *,
    include_io: bool = True,
    include_all_files: bool = False,
    mounts: tuple[str, ...] = (),
) -> dict[str, Any]:
    """The provenance graph of the loaded trace, in the web viewer's JSON shape."""
    acc: dict[str, Any] = {
        "entities": {},
        "activities": {},
        "types": {},
        "entity_relations": [],
        "stats": defaultdict(int),
    }
    query = (
        None
        if _relation_columns(trace)
        else 'cat == "PROV" or cat == "PROV_CONT" or name == "EH" or name == "ET" or name == "ER"'
    )
    wanted = ("name", "cat", "pid", "ts", "dur") + _arg_names(trace)
    for frame in trace.frames(wanted, query=query, phase="any"):
        for row in _rows(frame):
            _ingest(acc, row)

    # Legacy metadata helpers (prov_entity:/prov_type:) live in the M phase.
    meta = ("name", "cat", "pid", "ts", "args.name", "args.value")
    for frame in trace.frames(meta, phase="metadata"):
        for row in _rows(frame):
            _ingest_legacy_meta(acc, row)

    graph = _finish(acc)
    if not include_io or not graph["activities"]:
        return graph
    _attribute_io(trace, graph, include_all_files, mounts)
    return graph


def _attribute_io(
    trace: "TraceData",
    graph: dict[str, Any],
    include_all_files: bool,
    mounts: tuple[str, ...],
) -> None:
    spans = _span_index(graph["activities"])
    pid_of = {a["aid"]: a["pid"] for a in graph["activities"]}
    fh: dict[str, str] = {}
    rel_fh: dict[str, str] = {}
    sh: dict[str, str] = {}
    cwd_hash: dict[int, str] = {}
    agg: dict[tuple[str, str, str], list[int]] = {}
    events = attributed = 0

    query = 'cat == "POSIX" or cat == "STDIO" or name == "FH" or name == "SH" or name == "start"'
    for frame in trace.frames(_io_columns(trace), query=query, phase="any"):
        for row in _rows(frame):
            name = str(row.get("name") or "")
            if name in ("FH", "SH"):
                text = str(row.get("args.name") or "")
                h = str(row.get("args.value") or "")
                if not text or not h:
                    continue
                if name == "SH":
                    sh.setdefault(h, text)
                elif text.startswith("/"):
                    fh.setdefault(h, text)
                else:
                    rel_fh.setdefault(f"{int(row.get('pid') or 0)}:{h}", text)
                continue
            if name == "start":
                cwd = str(row.get("args.cwd") or "")
                if cwd:
                    cwd_hash.setdefault(int(row.get("pid") or 0), cwd)
                continue
            events += 1
            fhash = str(row.get("args.fhash") or "")
            if not fhash:
                continue
            aid = _find_span(spans, int(row.get("pid") or 0), int(row.get("ts") or 0))
            if aid is None:
                continue
            attributed += 1
            if name in ("rename", "renameat"):
                _add_io(agg, aid, fhash, "delete", 0)
                newpath = str(row.get("args.newpath_hash") or "")
                if newpath:
                    _add_io(agg, aid, newpath, "write", 0)
                continue
            op = _classify(name)
            ret = _int(row.get("args.ret"), 0)
            nbytes = 0
            if op in ("read", "write") and ret > 0:
                nbytes = ret
                size = _int(row.get("args.size"), 1)
                if name in ("fread", "fwrite") and size > 1:
                    nbytes *= size
            _add_io(agg, aid, fhash, op, nbytes)

    graph["stats"]["io_events"] = events
    graph["stats"]["io_attributed"] = attributed

    def resolve(fhash: str, pid: int) -> str:
        if fhash in fh:
            return fh[fhash]
        rel = rel_fh.get(f"{pid}:{fhash}")
        if rel is None:
            return ""
        cwd = sh.get(cwd_hash.get(pid, ""), "")
        if not cwd:
            return ""
        while rel.startswith("./"):
            rel = rel[2:]
        if rel in ("", "."):
            return cwd
        return cwd + ("" if cwd.endswith("/") else "/") + rel

    def keep(path: str) -> bool:
        return include_all_files or not _excluded(path)

    files: dict[str, dict[str, str]] = {}
    dropped: set[str] = set()

    def add_file(fhash: str, path: str) -> bool:
        if not path:
            return False
        if path in files:
            return True
        if not keep(path):
            dropped.add(path)
            return False
        files[path] = {"fhash": fhash, "path": path, "mount": "", "rel": ""}
        return True

    for (aid, fhash, op), (calls, nbytes) in agg.items():
        path = resolve(fhash, pid_of.get(aid, 0))
        if not add_file(fhash, path):
            continue
        graph["accesses"].append(
            {
                "aid": aid,
                "fhash": fhash,
                "path": path,
                "op": op,
                "calls": calls,
                "bytes": nbytes,
            }
        )

    for entity in graph["entities"]:
        uri = entity["uri"]
        if len(uri) < 2 or not uri.startswith("/"):
            continue
        for h, path in fh.items():
            if path == uri or (
                path.startswith(uri)
                and (uri.endswith("/") or path[len(uri) : len(uri) + 1] in ("/", "_", "."))
            ):
                if add_file(h, path):
                    graph["entity_files"].append(
                        {"entity": entity["hash"], "fhash": h, "path": path}
                    )

    graph["stats"]["files_excluded"] = len(dropped)

    table = _host_mounts(mounts)
    mount_type: dict[str, str] = {}
    for f in files.values():
        mount, rel = _split_mount(f["path"], table)
        f["mount"] = mount
        f["rel"] = rel
        if mount not in mount_type:
            kind = "unknown"
            for mt in table:
                if mt["path"] == mount:
                    kind = mt["fstype"]
            if kind == "unknown" and mount.startswith("/mnt/nnf/"):
                kind = "rabbit"
            mount_type[mount] = kind

    graph["files"] = sorted(files.values(), key=lambda f: f["path"])
    graph["mounts"] = sorted(
        ({"path": m, "fstype": t} for m, t in mount_type.items()), key=lambda m: m["path"]
    )
    graph["accesses"].sort(key=lambda a: (a["aid"], a["path"], a["op"]))
    graph["entity_files"].sort(key=lambda e: (e["entity"], e["path"]))
    graph["stats"]["files"] = len(graph["files"])
    graph["stats"]["mounts"] = len(graph["mounts"])


def _add_io(
    agg: dict[tuple[str, str, str], list[int]], aid: str, fhash: str, op: str, nbytes: int
) -> None:
    slot = agg.setdefault((aid, fhash, op), [0, 0])
    slot[0] += 1
    slot[1] += nbytes


def _rows(frame: "DataFrame") -> Iterator[dict[str, Any]]:
    data = frame.to_dict()
    if not data:
        return
    keys = list(data)
    for values in zip(*(data[k] for k in keys)):
        yield dict(zip(keys, values))
