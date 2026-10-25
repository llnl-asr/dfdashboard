"""The call tree, folded by the engine instead of by a local kernel.

One viewer over the whole file set is the only way the engine can fold every
file at once: `flamegraph` is a plan root, and it cannot follow a concat of
per-file plans. The fold aggregates by call path, so the payload is a few
hundred nodes rather than one node per event.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Optional

from dftracer.utils import TraceViewer

from ..data._calltree import TreeNode
from .questions.types import CalltreePayload

if TYPE_CHECKING:
    from .data import TraceData


def _files_of(trace: "TraceData") -> list[str]:
    """The trace files themselves: a trace path may be the directory holding them."""
    out: list[str] = []
    for p in trace._paths:
        if os.path.isdir(p):
            out.extend(
                os.path.join(p, n) for n in sorted(os.listdir(p)) if n.endswith((".pfw.gz", ".pfw"))
            )
        else:
            out.append(p)
    return out


def _set_view(trace: "TraceData") -> Optional[TraceViewer]:
    """One viewer over every file of the trace, opened once and reused."""
    if trace._setview is not None:
        return trace._setview or None
    paths = _files_of(trace)
    if not paths:
        trace._setview = False
        return None
    index = os.path.join(trace._index_dir, "set.parquet") if trace._index_dir else None
    try:
        # With more than one file the viewer cannot infer a schema, so name it;
        # without a time role the fold refuses to run.
        trace._setview = TraceViewer(paths, index_path=index, record_schema="dftracer")
    except Exception:
        trace._setview = False
        return None
    return trace._setview


def _nest(rows: dict[str, list[Any]], by_process: bool) -> TreeNode:
    """Flat node rows as the nested tree the view draws.

    ``count`` is the number of events folded into that node alone, not into its
    subtree: a chain a>b>c gives every node count 1, and a paths folded twice
    gives count 2. The view sums upward itself (`flame/sandwich.ts`), so the
    payload must not pre-sum it.
    """
    nodes: dict[int, TreeNode] = {}
    for i, node_id in enumerate(rows["node_id"]):
        name = str(rows["name"][i])
        level = int(rows["level"][i])
        if by_process and level == 1:
            name = f"P{name}"
        nodes[int(node_id)] = TreeNode(
            name=name,
            total=float(rows["total"][i]),
            self=float(rows["self"][i]),
            count=int(rows["count"][i]),
            children=[],
        )
    for i, node_id in enumerate(rows["node_id"]):
        parent = int(rows["parent"][i])
        if parent in nodes:
            nodes[parent]["children"].append(nodes[int(node_id)])
    return nodes.get(0, TreeNode(name="all", total=0.0, self=0.0, count=0, children=[]))


def calltree(
    trace: "TraceData",
    begin: float,
    end: float,
    query: Optional[str] = None,
    by_process: bool = False,
) -> CalltreePayload:
    view = _set_view(trace)
    if view is None:
        return CalltreePayload(
            truncated=False, tree=TreeNode(name="all", total=0.0, self=0.0, count=0, children=[])
        )
    m = trace.info()
    gmin = m.global_min_ts
    lo, hi = int(begin + gmin), int(end + gmin)
    clauses = [f"ts >= {lo}", f"ts <= {hi}"]
    if query:
        clauses.append(f"({query})")
    plan = view.filter(" and ".join(clauses)).flamegraph(
        partition=("pid", "tid"), group=("pid",) if by_process else ()
    )
    rows = plan.collect().to_dict()
    if not rows.get("node_id"):
        return CalltreePayload(
            truncated=False, tree=TreeNode(name="all", total=0.0, self=0.0, count=0, children=[])
        )
    return CalltreePayload(truncated=False, tree=_nest(rows, by_process))
