"""Dashboard layout persistence: named dashboards in one JSON file next to the
index, durable and shared across browsers.
"""

from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, Depends

from ..core.errors import UNKNOWN_DASHBOARD, ApiError
from .deps import get_index_dir

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _path(index_dir: str) -> str:
    os.makedirs(index_dir, exist_ok=True)
    return os.path.join(index_dir, "dashboards.json")


def _load(index_dir: str) -> dict[str, Any]:
    p = _path(index_dir)
    if os.path.exists(p):
        try:
            with open(p) as f:
                d = json.load(f)
                return d if isinstance(d, dict) else {}
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def _save(index_dir: str, data: dict[str, Any]) -> None:
    with open(_path(index_dir), "w") as f:
        json.dump(data, f)


@router.get("/list")
async def list_dashboards(index_dir: str = Depends(get_index_dir)) -> dict[str, list[str]]:
    return {"names": sorted(_load(index_dir).keys())}


@router.get("/get/{name}")
async def get_dashboard(name: str, index_dir: str = Depends(get_index_dir)) -> dict[str, Any]:
    return _load(index_dir).get(name) or {"cards": None, "layout": None}


@router.put("/put/{name}")
async def put_dashboard(
    name: str, body: dict[str, Any], index_dir: str = Depends(get_index_dir)
) -> dict[str, bool]:
    data = _load(index_dir)
    data[name] = body
    _save(index_dir, data)
    return {"ok": True}


@router.delete("/{name}")
async def delete_dashboard(name: str, index_dir: str = Depends(get_index_dir)) -> dict[str, bool]:
    data = _load(index_dir)
    if name not in data:
        raise ApiError(404, UNKNOWN_DASHBOARD, "unknown dashboard")
    del data[name]
    _save(index_dir, data)
    return {"ok": True}
