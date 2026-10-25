"""The twelve overview cards.

Each class is a title plus the one fetch that fills it; the base classes own the
refresh loop, the placeholder and the error path.
"""

from __future__ import annotations

import io
from typing import Sequence, cast

import pyarrow.ipc as ipc
from bokeh.document import Document
from bokeh.models import ColumnDataSource
from bokeh.plotting import figure as Figure

from ..core.theme import palette
from ..runtime.tasks import Lane, TaskSpec
from ..trace.questions.types import (
    AccessPatternPayload,
    HistogramPayload,
    OpStatsPayload,
    ProcBytesPayload,
    SizeHistogramPayload,
)
from . import rows as R
from . import session as S
from .base import FULL_TRACE_NOTE, CanvasCard, Card, HtmlCard, bars, busy
from .charts import themed_figure


class IoByHost(HtmlCard):
    id = "io_summary"
    title = "I/O by host"

    async def body(self, doc: Document) -> str | None:
        # No cache: a cached empty-param spec kept the first result forever, so
        # the card showed the hosts that existed when it first painted.
        spec = TaskSpec(pipeline_id="io_summary", lane=Lane.NORMAL)
        res = await S.run_task(self.app, spec) if S.has_trace(self.app) else None
        if res is None:
            return busy()
        data = cast("dict[str, object]", res.data)
        return (
            bars(R.rows_host_bytes(cast("dict[str, float]", data["bytes_by_host"])))
            + FULL_TRACE_NOTE
        )


class AccessPattern(HtmlCard):
    id = "access_pattern"
    title = "Access pattern"
    busy = "analyzing trace..."

    async def body(self, doc: Document) -> str | None:
        res = await S.compute(self.app, doc, "access_pattern")
        if res is None:
            return busy()
        rws, note = R.rows_access(cast("AccessPatternPayload", res.data))
        return bars(rws) + f'<div class="pcard-note">{note}</div>'


class BarCard(HtmlCard):
    """A bar card over one `card_compute` op, responding to the window filter."""

    busy = "loading..."
    op = "op_stats"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        raise NotImplementedError

    async def body(self, doc: Document) -> str | None:
        res = await S.compute(self.app, doc, self.op)
        return bars(self.rows(res.data)) if res else busy()


class OpTime(BarCard):
    id = "op_time"
    title = "I/O time by operation"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_op_time(cast("OpStatsPayload", data))


class OpCounts(BarCard):
    id = "op_counts"
    title = "Operation counts"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_op_counts(cast("OpStatsPayload", data))


class ReadWrite(BarCard):
    id = "read_write"
    title = "Read vs write (bytes)"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_read_write(cast("OpStatsPayload", data))


class AvgXfer(BarCard):
    id = "avg_xfer"
    title = "Avg transfer size"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_avg_xfer(cast("OpStatsPayload", data))


class DataMeta(BarCard):
    id = "data_meta"
    title = "Data vs metadata time"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_data_meta(cast("OpStatsPayload", data))


class BwByHost(BarCard):
    id = "bw_by_host"
    title = "Bandwidth by host"
    op = "proc_bytes"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_bw_by_host(cast("ProcBytesPayload", data))


class Busiest(BarCard):
    id = "busiest"
    title = "Busiest processes (I/O bytes)"
    op = "proc_bytes"

    def rows(self, data: object) -> list[tuple[str, float, str]]:
        return R.rows_busiest(cast("ProcBytesPayload", data))


class Bandwidth(CanvasCard):
    id = "bandwidth"
    title = "I/O bandwidth (GB/s)"

    def empty(self) -> dict[str, object]:
        return {"x": [], "read": [], "write": []}

    def chart(self, source: ColumnDataSource) -> Figure:
        c = palette(self.theme)
        p = themed_figure()
        p.line("x", "read", source=source, line_color=c["read"], line_width=2, legend_label="read")
        p.line(
            "x", "write", source=source, line_color=c["write"], line_width=2, legend_label="write"
        )
        p.legend.location = "top_left"
        p.xaxis.axis_label = "seconds"
        return p

    async def body(self, doc: Document) -> dict[str, Sequence[float]] | None:
        n = 120
        res = await S.compute(self.app, doc, "counters", n=n)
        if res is None:
            return None
        tbl = ipc.open_stream(io.BytesIO(cast("bytes", res.data))).read_all()
        read = tbl.column("read_bytes").to_pylist()
        write = tbl.column("write_bytes").to_pylist()
        begin = cast("float", res.meta["begin"])
        end = cast("float", res.meta["end"])
        window = end - begin
        bucket_s = max((window / n) / 1e6, 1e-9)
        # Elapsed seconds at each bucket center, not the raw bucket index.
        return {
            "x": [(i + 0.5) * bucket_s for i in range(n)],
            "read": [r / bucket_s / 1e9 for r in read],
            "write": [w / bucket_s / 1e9 for w in write],
        }


class Latency(CanvasCard):
    id = "latency"
    title = "Operation latency"
    x_axis_type = "log"

    def empty(self) -> dict[str, object]:
        return {"x": [], "count": []}

    def chart(self, source: ColumnDataSource) -> Figure:
        c = palette(self.theme)
        p = themed_figure(x_axis_type="log")
        p.varea(x="x", y1=0, y2="count", source=source, fill_color=c["read"], fill_alpha=0.35)
        p.line("x", "count", source=source, line_color=c["read"], line_width=2)
        p.xaxis.axis_label = "duration (us)"
        return p

    async def body(self, doc: Document) -> dict[str, Sequence[float]] | None:
        res = await S.compute(self.app, doc, "histogram", n=60)
        return None if res is None else _histogram(cast("HistogramPayload", res.data), floor=1e-3)


class XferHist(CanvasCard):
    id = "xfer_hist"
    title = "Transfer sizes"

    def empty(self) -> dict[str, object]:
        return {"x": [], "count": []}

    def chart(self, source: ColumnDataSource) -> Figure:
        c = palette(self.theme)
        p = themed_figure(x_axis_type="log")
        p.varea(x="x", y1=0, y2="count", source=source, fill_color=c["write"], fill_alpha=0.35)
        p.line("x", "count", source=source, line_color=c["write"], line_width=2)
        p.xaxis.axis_label = "bytes"
        return p

    async def body(self, doc: Document) -> dict[str, Sequence[float]] | None:
        res = await S.compute(self.app, doc, "size_histogram", nbuckets=48)
        return (
            None if res is None else _histogram(cast("SizeHistogramPayload", res.data), floor=1.0)
        )


def _histogram(
    data: HistogramPayload | SizeHistogramPayload, floor: float
) -> dict[str, Sequence[float]]:
    """Geometric-mean bucket centers on a log axis, since a linear one hides the tail."""
    xs, cs = [], []
    for b in data.get("buckets", []):
        lo, hi = float(b["lo"]), float(b["hi"])
        xs.append((lo * hi) ** 0.5 if lo > 0 and hi > 0 else max(lo, floor))
        cs.append(int(b["count"]))
    return {"x": xs, "count": cs}


CARDS: tuple[type[Card], ...] = (
    IoByHost,
    Bandwidth,
    Latency,
    XferHist,
    AccessPattern,
    OpTime,
    OpCounts,
    ReadWrite,
    AvgXfer,
    DataMeta,
    BwByHost,
    Busiest,
)
