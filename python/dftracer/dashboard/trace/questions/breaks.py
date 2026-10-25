"""Dead time between runs: what the timeline compresses and the cards report."""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from dftracer.utils.columnar import F

from ...trace.frame import _agg, _group, _rows
from . import Question
from .types import BreaksPayload, Gap

if TYPE_CHECKING:
    from dftracer.utils import DataFrame

    from . import Context

APP_SPAN_QUERY = 'cat == "dftracer" and (name == "start" or name == "end")'


def merge(intervals: list[tuple[int, int]]) -> list[list[int]]:
    """Union of [start, end] intervals, so overlapping runs read as one."""
    out: list[list[int]] = []
    for lo, hi in sorted(intervals):
        if out and lo <= out[-1][1]:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def select_gaps(
    merged: list[list[int]], total: int, min_us: int, min_frac: float, max_count: int
) -> list[Gap]:
    """Keep only the gaps worth compressing, biggest first, then back in time order."""
    min_gap = max(min_us, min_frac * total)
    gaps = [Gap(begin=a[1], end=b[0]) for a, b in zip(merged, merged[1:]) if b[0] - a[1] >= min_gap]
    if len(gaps) > max_count:
        gaps = sorted(gaps, key=lambda g: g["end"] - g["begin"], reverse=True)
        gaps = sorted(gaps[:max_count], key=lambda g: g["begin"])
    return gaps


def app_spans(frame: "DataFrame") -> list[tuple[int, int]]:
    """Per-process [start, end] absolute-microsecond intervals from the app records."""
    if frame.height == 0:
        return []
    starts: dict[int, int] = {}
    ends: dict[int, int] = {}
    grp = _agg(_group(frame, ["pid", "name"]), F.ts.min().alias("lo"), F.ts.max().alias("hi"))
    for r in _rows(grp):
        pid = int(r["pid"])
        if r["name"] == "start":
            cur = starts.get(pid)
            if cur is None or r["lo"] < cur:
                starts[pid] = int(r["lo"])
        elif r["name"] == "end":
            cur = ends.get(pid)
            if cur is None or r["hi"] > cur:
                ends[pid] = int(r["hi"])
    return [(s, ends[pid]) for pid, s in starts.items() if pid in ends and ends[pid] > s]


def break_report(frame: "DataFrame", ctx: "Context") -> BreaksPayload:
    """Gaps, multi-run flag and the timing window that malformed events sit outside."""
    info = ctx.info()
    gmin = info.global_min_ts
    total = info.global_max_ts - gmin
    min_us, min_frac, max_count = ctx.gap_limits()
    if total <= 0:
        return BreaksPayload(gaps=[], multi_run=False, valid_start=0, valid_end=0, max_life=0)
    app = app_spans(frame)
    if app:
        merged = merge([(s - gmin, e - gmin) for s, e in app])
    else:
        # Fallback: per-file bounds when the trace has no app-span records.
        merged = merge([(b[0] - gmin, b[1] - gmin) for b in info.bounds if b is not None])
        if not merged:
            return BreaksPayload(gaps=[], multi_run=False, valid_start=0, valid_end=0, max_life=0)
    gaps = select_gaps(merged, total, min_us, min_frac, max_count)
    # The trustworthy window: the earliest a process began and the longest it ran.
    # An event outside it has impossible timing, which the timeline hides by default.
    valid_start = max(0, min((s for s, _ in app), default=gmin) - gmin) if app else 0
    valid_end = max((e for _, e in app), default=info.global_max_ts) - gmin if app else 0
    max_life = max((e - s for s, e in app), default=0) if app else 0
    return BreaksPayload(
        gaps=gaps,
        multi_run=bool(gaps),
        valid_start=valid_start,
        valid_end=valid_end,
        max_life=max_life,
    )


class Breaks(Question):
    """Dead time between runs, plus the window in which the timings make sense."""

    __slots__ = ()

    name: ClassVar[str] = "breaks"
    columns: ClassVar[tuple[str, ...]] = ("name", "pid", "ts")

    def shape(self, frame: "DataFrame", ctx: "Context") -> BreaksPayload:
        return break_report(frame, ctx)
