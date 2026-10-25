"""The call tree's shape.

The tree itself is folded by the engine (`LazyFrame.flamegraph`); this module
only names what the fold returns, so the payload has one type.
"""

from __future__ import annotations

from typing import TypedDict


class TreeNode(TypedDict):
    name: str
    total: float
    self: float
    count: int
    children: list["TreeNode"]
