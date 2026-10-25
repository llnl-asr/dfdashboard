"""Duration and transfer-size distributions: what the latency cards show."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from dftracer.utils.columnar import F

from ...trace.frame import _col, _log_hist, _num
from . import Question
from .types import Bucket, HistogramPayload, SizeHistogramPayload

if TYPE_CHECKING:
    from dftracer.utils import DataFrame

    from . import Context


def _buckets(d: "DataFrame", field: str, nbuckets: int) -> tuple[float, float, list[Bucket]]:
    lo, hi = _num(_col(d, field).min()), _num(_col(d, field).max())
    out: list[Bucket] = []
    if hi > lo > 0:
        edges, counts = _log_hist(d, field, lo, hi, nbuckets)
        out = [Bucket(lo=edges[i], hi=edges[i + 1], count=counts[i]) for i in range(nbuckets)]
    elif hi == lo > 0:
        out = [Bucket(lo=lo, hi=lo, count=d.height)]
    return lo, hi, out


@dataclass(frozen=True, slots=True)
class Histogram(Question[HistogramPayload]):
    """Percentiles plus a log-scale bucket count of every event duration."""

    nbuckets: int = 48

    name: ClassVar[str] = "histogram"
    columns: ClassVar[tuple[str, ...]] = ("dur",)

    def shape(self, frame: "DataFrame", ctx: "Context") -> HistogramPayload:
        empty = HistogramPayload(
            count=0,
            min=0,
            max=0,
            mean=0,
            p50=0,
            p90=0,
            p95=0,
            p99=0,
            truncated=False,
            buckets=[],
        )
        d = frame.filter(F.dur > 0) if frame.height else frame
        if d.height == 0:
            return {**empty, "count": frame.height}
        dur = _col(d, "dur")
        lo, hi, buckets = _buckets(d, "dur", self.nbuckets)
        return HistogramPayload(
            count=frame.height,
            min=lo,
            max=hi,
            mean=float(dur.mean()),
            p50=float(dur.quantile(0.50)),
            p90=float(dur.quantile(0.90)),
            p95=float(dur.quantile(0.95)),
            p99=float(dur.quantile(0.99)),
            truncated=False,
            buckets=buckets,
        )


@dataclass(frozen=True, slots=True)
class SizeHistogram(Question[SizeHistogramPayload]):
    """Log-scale distribution of transfer sizes: the bytes a read or write moved."""

    nbuckets: int = 48

    name: ClassVar[str] = "size_histogram"
    columns: ClassVar[tuple[str, ...]] = ("name", "ret")

    def shape(self, frame: "DataFrame", ctx: "Context") -> SizeHistogramPayload:
        if frame.height == 0 or "ret" not in frame.columns:
            return SizeHistogramPayload(count=0, buckets=[])
        d = frame.filter((F.ret > 0) & ctx.io_mask())
        if d.height == 0:
            return SizeHistogramPayload(count=0, buckets=[])
        _lo, _hi, buckets = _buckets(d, "ret", self.nbuckets)
        return SizeHistogramPayload(count=d.height, buckets=buckets)
