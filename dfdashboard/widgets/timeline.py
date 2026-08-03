"""Timeline widget. ESM built from web/src/widget/timeline.widget.tsx."""

from __future__ import annotations

import io
import json
import pathlib
from typing import Any, Optional

import param
import pyarrow as pa
from panel.custom import AnyWidgetComponent

_STATIC = pathlib.Path(__file__).parent / "static"
_COUNTER_BUCKETS = 1200
_SERIES_BUCKETS = 700


def _zstd(blob: bytes) -> bytes:
    return pa.compress(blob, codec="zstd", asbytes=True) if blob else b""


def _series_json(trace: Any, begin: float, end: float) -> bytes:
    # ph="C" counter series for the overlay, as JSON bytes (zstd'd by caller).
    payload = trace.counter_series(begin, end, _SERIES_BUCKETS, None)
    return json.dumps(payload).encode("utf-8")


def _proctree_ipc(trace: Any) -> bytes:
    nodes = trace.proctree().get("nodes", [])
    if not nodes:
        return b""
    table = pa.Table.from_pylist(nodes)
    sink = io.BytesIO()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue()


class TimelineWidget(AnyWidgetComponent):
    _esm = _STATIC / "timeline.js"

    # Panel debounces JS->Python property syncs by 50ms to coalesce rapid
    # updates; our viewport requests are already debounced client-side, so drop
    # it to keep the pan/zoom re-query round-trip low-latency.
    _debounce = 0

    begin = param.Number(default=0.0)
    end = param.Number(default=0.0)
    width = param.Integer(default=1200)
    span = param.Number(default=0.0)
    req = param.Integer(default=0)
    timeline_ipc = param.Bytes(default=b"")
    counters_ipc = param.Bytes(default=b"")
    series_ipc = param.Bytes(default=b"")
    proctree_ipc = param.Bytes(default=b"")
    overview_ipc = param.Bytes(default=b"")
    # Breaks are a handful of [begin, end] gaps; small enough to sync as-is.
    breaks_gaps = param.List(default=[])
    multi_run = param.Boolean(default=False)
    # breaks() returns every dead-time gap; a busy workflow can have dozens of
    # tiny ones. Only render gaps at least this fraction of the total span, so
    # the broken axis stays readable without an arbitrary count cap.
    min_break_frac = param.Number(default=0.01)

    def __init__(self, trace: Optional[Any] = None, **params: Any) -> None:
        super().__init__(**params)
        self._trace = trace
        if trace is not None:
            meta = trace.info()
            self.span = float(meta.global_max_ts - meta.global_min_ts)
            self.end = self.span
            self.proctree_ipc = _zstd(_proctree_ipc(trace))
            self.overview_ipc = _zstd(
                b"".join(trace.timeline_stream(0.0, self.span, self.width, 2, 0.0, None))
            )
            brk = trace.breaks()
            floor = self.min_break_frac * self.span
            gaps = [g for g in brk["gaps"] if g["end"] - g["begin"] >= floor]
            self.breaks_gaps = [[g["begin"], g["end"]] for g in gaps]
            self.multi_run = brk["multi_run"]
            self._reload()

    @param.depends("req", watch=True)
    def _on_req(self) -> None:
        self._reload()

    def _reload(self) -> None:
        if self._trace is None:
            return
        self.timeline_ipc = _zstd(
            b"".join(self._trace.timeline_stream(self.begin, self.end, self.width, 1, 0.0, None))
        )
        self.counters_ipc = _zstd(
            self._trace.counters_arrow(self.begin, self.end, _COUNTER_BUCKETS, None)
        )
        self.series_ipc = _zstd(_series_json(self._trace, self.begin, self.end))
