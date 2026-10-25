"""Flamegraph containment merge: fold sorted events into a call tree (numba JIT
with a pure-Python fallback)."""

from __future__ import annotations

from typing import Any

import numpy as np

try:
    from numba import njit
    from numba.core import types
    from numba.typed import Dict

    _HAVE_NUMBA = True
except Exception:  # pragma: no cover - numba optional
    _HAVE_NUMBA = False


def _arena_py(
    pids: Any, tids: Any, tss: Any, durs: Any, codes: Any, ncodes: int, by_process: bool, cap: int
) -> tuple:
    node_total = np.zeros(cap, np.float64)
    node_self = np.zeros(cap, np.float64)
    node_count = np.zeros(cap, np.int64)
    node_code = np.full(cap, -1, np.int64)
    node_parent = np.full(cap, -1, np.int64)
    node_pid = np.full(cap, -1, np.int64)
    nn = 1  # 0 is the root
    child_of: dict[int, int] = {}
    proc_of: dict[int, int] = {}
    n = len(pids)
    open_end = np.empty(n, np.float64)
    open_node = np.empty(n, np.int64)
    osz = 0
    cpid = ctid = -1
    base = 0
    first = True
    for k in range(n):
        pid = pids[k]
        tid = tids[k]
        if first or pid != cpid or tid != ctid:
            first = False
            cpid, ctid, osz = pid, tid, 0
            if by_process:
                b = proc_of.get(pid, -1)
                if b < 0:
                    b = nn
                    node_pid[nn] = pid
                    node_parent[nn] = 0
                    nn += 1
                    proc_of[pid] = b
                base = b
            else:
                base = 0
        ts = tss[k]
        dur = durs[k]
        d = dur if dur > 0 else 0.0
        while osz > 0 and open_end[osz - 1] <= ts:
            osz -= 1
        parent = open_node[osz - 1] if osz > 0 else base
        key = parent * ncodes + codes[k]
        mi = child_of.get(key, -1)
        if mi < 0:
            mi = nn
            node_code[nn] = codes[k]
            node_parent[nn] = parent
            nn += 1
            child_of[key] = mi
        node_total[mi] += d
        node_self[mi] += d
        node_count[mi] += 1
        if parent != 0:
            node_self[parent] -= d
        open_end[osz] = ts + d
        open_node[osz] = mi
        osz += 1
    return nn, node_total, node_self, node_count, node_code, node_parent, node_pid


if _HAVE_NUMBA:

    @njit(cache=True)
    def _arena_nb(pids, tids, tss, durs, codes, ncodes, by_process, cap):  # pragma: no cover
        node_total = np.zeros(cap, np.float64)
        node_self = np.zeros(cap, np.float64)
        node_count = np.zeros(cap, np.int64)
        node_code = np.full(cap, -1, np.int64)
        node_parent = np.full(cap, -1, np.int64)
        node_pid = np.full(cap, -1, np.int64)
        nn = 1
        child_of = Dict.empty(types.int64, types.int64)
        proc_of = Dict.empty(types.int64, types.int64)
        n = len(pids)
        open_end = np.empty(n, np.float64)
        open_node = np.empty(n, np.int64)
        osz = 0
        cpid = ctid = -1
        base = 0
        first = True
        for k in range(n):
            pid = pids[k]
            tid = tids[k]
            if first or pid != cpid or tid != ctid:
                first = False
                cpid, ctid, osz = pid, tid, 0
                if by_process:
                    if pid in proc_of:
                        base = proc_of[pid]
                    else:
                        base = nn
                        node_pid[nn] = pid
                        node_parent[nn] = 0
                        nn += 1
                        proc_of[pid] = base
                else:
                    base = 0
            ts = tss[k]
            dur = durs[k]
            d = dur if dur > 0 else 0.0
            while osz > 0 and open_end[osz - 1] <= ts:
                osz -= 1
            parent = open_node[osz - 1] if osz > 0 else base
            key = parent * ncodes + codes[k]
            if key in child_of:
                mi = child_of[key]
            else:
                mi = nn
                node_code[nn] = codes[k]
                node_parent[nn] = parent
                nn += 1
                child_of[key] = mi
            node_total[mi] += d
            node_self[mi] += d
            node_count[mi] += 1
            if parent != 0:
                node_self[parent] -= d
            open_end[osz] = ts + d
            open_node[osz] = mi
            osz += 1
        return nn, node_total, node_self, node_count, node_code, node_parent, node_pid


def _arena_to_tree(res: tuple, cats: list[str], by_process: bool) -> dict[str, Any]:
    nn, node_total, node_self, node_count, node_code, node_parent, node_pid = res
    total = node_total.tolist()
    selfd = node_self.tolist()
    count = node_count.tolist()
    code = node_code.tolist()
    parent = node_parent.tolist()
    npid = node_pid.tolist()
    children: list[list[int]] = [[] for _ in range(nn)]
    for i in range(1, nn):
        children[parent[i]].append(i)  # ascending i == insertion order

    if by_process:
        for pnode in children[0]:
            total[pnode] = sum(total[c] for c in children[pnode])
            count[pnode] = sum(count[c] for c in children[pnode])
            selfd[pnode] = 0.0
    total[0] = sum(total[c] for c in children[0])
    count[0] = sum(count[c] for c in children[0])
    selfd[0] = 0.0

    def name_of(i: int) -> str:
        if i == 0:
            return "all"
        if npid[i] >= 0:
            return f"P{npid[i]}"
        return cats[code[i]]

    def to_json(i: int) -> dict[str, Any]:
        return {
            "name": name_of(i),
            "total": total[i],
            "self": max(selfd[i], 0.0),
            "count": count[i],
            "children": [to_json(c) for c in children[i]],
        }

    return to_json(0)


def build_tree(
    pids: Any, tids: Any, tss: Any, durs: Any, codes: Any, cats: list[str], by_process: bool
) -> dict[str, Any]:
    n = len(pids)
    if n == 0:
        return {"name": "all", "total": 0, "self": 0, "count": 0, "children": []}
    ncodes = len(cats)
    nproc = int(np.unique(pids).size) if by_process else 0
    cap = n + nproc + 2
    kernel = _arena_nb if _HAVE_NUMBA else _arena_py
    res = kernel(pids, tids, tss, durs, codes, ncodes, by_process, cap)
    return _arena_to_tree(res, cats, by_process)


def warmup() -> None:
    """Compile the JIT kernel off the request path (numba caches to disk)."""
    if not _HAVE_NUMBA:
        return
    z = np.zeros(1, np.int64)
    zf = np.zeros(1, np.float64)
    for bp in (False, True):
        build_tree(z, z, zf, zf, z, ["x"], bp)
