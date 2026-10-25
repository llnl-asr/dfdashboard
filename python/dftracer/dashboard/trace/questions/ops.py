"""Operation questions: what the per-operation, access and call-tree cards show."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from dftracer.utils.columnar import F, count

from ...trace.frame import _agg, _first, _group, _num, _rows
from ...trace.schema import _INTRINSIC, _PH_COUNTER, _READ, _SEEK, _WRITE
from . import Question
from .types import (
    AccessPatternPayload,
    NameStatRow,
    OpStatRow,
    OpStatsPayload,
    StatsPayload,
)

if TYPE_CHECKING:
    from dftracer.utils import DataFrame

    from . import Context

_OPS = (
    ("read", _READ),
    ("write", _WRITE),
    ("open", r"open"),
    ("close", r"close"),
    ("stat", r"stat"),
    ("seek", _SEEK),
    ("sync", r"sync|flush"),
)


class OpStats(Question[OpStatsPayload]):
    """Per-operation time, count and bytes, by event name."""

    __slots__ = ()

    name: ClassVar[str] = "op_stats"
    columns: ClassVar[tuple[str, ...]] = ("name", "dur", "ret")

    def shape(self, frame: "DataFrame", ctx: "Context") -> OpStatsPayload:
        out: OpStatsPayload = {op: OpStatRow(time=0.0, count=0, bytes=0) for op, _ in _OPS}
        if frame.height == 0:
            return out
        for op, pattern in _OPS:
            sel = frame.filter(F.name.lower().regex(pattern))
            if sel.height == 0:
                continue
            row = _first(_agg(_group(sel), F.dur.sum().alias("t"), count().alias("n")))
            moved = 0
            if op in ("read", "write"):
                totals = _first(_agg(_group(sel.filter(F.ret > 0)), F.ret.sum().alias("bytes")))
                moved = int(_num(totals.get("bytes") or 0))
            out[op] = OpStatRow(time=float(row["t"] or 0) / 1e6, count=int(row["n"]), bytes=moved)
        return out


class AccessPattern(Question[AccessPatternPayload]):
    """Sequential vs random reads.

    Exact when reads carry an offset (POSIX pread/pwrite): a read is sequential
    iff offset == the previous read's offset + bytes for that file. Otherwise a
    seek heuristic: a read right after a seek counts as random.
    """

    __slots__ = ()

    name: ClassVar[str] = "access_pattern"
    columns: ClassVar[tuple[str, ...]] = ("name", "ts", "fhash", "ret", "offset")

    def shape(self, frame: "DataFrame", ctx: "Context") -> AccessPatternPayload:
        empty = AccessPatternPayload(sequential=0, random=0, seeks=0, method="none")
        if frame.height == 0 or "fhash" not in frame.columns:
            return empty
        both = F.name.lower().regex(_READ) | F.name.lower().regex(_SEEK)
        d = frame.filter(F.fhash.is_not_null() & both)
        if d.height == 0:
            return empty
        reads = d.filter(F.name.lower().regex(_READ))
        seeks = d.height - reads.height
        if reads.height and "offset" in reads.columns:
            if reads.filter(F.offset.is_not_null()).height >= reads.height * 0.5:
                r = reads.window(
                    partition_by=["fhash"],
                    order_by=["ts"],
                    specs=[("lag", "offset", 1, "poff"), ("lag", "ret", 1, "pret")],
                )
                seq = r.filter(
                    F.poff.is_null()
                    | F.offset.is_null()
                    | (F.offset == (F.poff + F.pret.fillna(0)))
                ).height
                return AccessPatternPayload(
                    sequential=seq,
                    random=reads.height - seq,
                    seeks=seeks,
                    method="offset",
                )
        marked = d.assign(_seek=F.name.lower().regex(_SEEK))
        w = marked.window(
            partition_by=["fhash"], order_by=["ts"], specs=[("lag", "_seek", 1, "prevseek")]
        )
        rd = w.filter(~F("_seek"))
        random = rd.filter(F.prevseek.fillna(False)).height
        return {
            "sequential": rd.height - random,
            "random": random,
            "seeks": seeks,
            "method": "seek",
        }


@dataclass(frozen=True, slots=True)
class Stats(Question[StatsPayload]):
    """Event count, total and wall time, plus the same numbers per group."""

    group: str = "name"

    name: ClassVar[str] = "stats"
    columns: ClassVar[tuple[str, ...]] = _INTRINSIC

    def shape(self, frame: "DataFrame", ctx: "Context") -> StatsPayload:
        empty = StatsPayload(count=0, total_dur=0, wall=0, truncated=False, names=[])
        # Counter readings (ph=C) have no duration; their own endpoints cover them.
        if frame.height:
            frame = frame.filter(F.ph != _PH_COUNTER)
        if frame.height == 0:
            return empty
        key = self.group if self.group in frame.columns else "name"
        grp = _agg(
            _group(frame, key),
            count().alias("count"),
            F.dur.sum().alias("total"),
            F.dur.mean().alias("avg"),
            F.dur.min().alias("min"),
            F.dur.max().alias("max"),
        ).sort_values(["total"], ascending=[False])
        names = [
            NameStatRow(
                name=str(r[key]),
                count=int(r["count"]),
                total=int(r["total"] or 0),
                avg=float(r["avg"] or 0),
                min=int(r["min"] or 0),
                max=int(r["max"] or 0),
            )
            for r in _rows(grp)
        ]
        span = _first(_agg(_group(frame), F.ts.min().alias("lo"), (F.ts + F.dur).max().alias("hi")))
        wall = int(span["hi"] or 0) - int(span["lo"] or 0)
        return StatsPayload(
            count=frame.height,
            total_dur=int(_num(_first(_agg(_group(frame), F.dur.sum()))["sum_dur"])),
            wall=wall,
            truncated=False,
            names=names,
        )
