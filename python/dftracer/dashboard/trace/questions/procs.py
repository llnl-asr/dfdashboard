"""Per-process questions: what the busiest and per-host cards show."""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from dftracer.utils.columnar import F, count

from ...trace.frame import _agg, _group, _int, _num, _rows
from ...trace.schema import _READ, _WRITE
from . import Question
from .types import ProcBytesPayload, ProcBytesRow

if TYPE_CHECKING:
    from dftracer.utils import DataFrame

    from . import Context


class ProcBytes(Question[ProcBytesPayload]):
    """I/O bytes and busy time per process, with the host that ran it."""

    __slots__ = ()

    name: ClassVar[str] = "proc_bytes"
    columns: ClassVar[tuple[str, ...]] = ("name", "pid", "dur", "ret")

    def shape(self, frame: "DataFrame", ctx: "Context") -> ProcBytesPayload:
        if frame.height == 0:
            return []
        d = frame.filter(F.name.lower().regex(_READ) | F.name.lower().regex(_WRITE))
        if d.height == 0:
            return []
        busy = _rows(_agg(_group(d, "pid"), count().alias("n"), F.dur.sum().alias("t")))
        moved = {
            int(r["pid"]): r["b"]
            for r in _rows(_agg(_group(d.filter(F.ret > 0), "pid"), F.ret.sum().alias("b")))
        }
        pid2host = ctx.pid_host_map()
        out = [
            ProcBytesRow(
                pid=int(r["pid"]),
                host=pid2host.get(str(int(r["pid"])), "?"),
                bytes=_int(moved.get(int(r["pid"]))),
                time_us=_num(r["t"]),
                count=_int(r["n"]),
            )
            for r in busy
        ]
        return sorted(out, key=lambda p: -p["bytes"])
