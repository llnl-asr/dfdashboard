"""The call tree's shape.

The tree itself is folded by the engine (`LazyFrame.flamegraph`); this module
only names what the fold returns, so the payload has one type.
"""

from __future__ import annotations

from typing_extensions import TypedDict


class TreeNode(TypedDict):
    name: str
    total: float
    self: float
    count: int
    children: list["TreeNode"]


# A FastAPI response model is rebuilt after the route is registered, when this
# module's globals may not be reachable, so the recursive field carries the
# class itself and not a forward reference.
TreeNode.__annotations__["children"] = list[TreeNode]
