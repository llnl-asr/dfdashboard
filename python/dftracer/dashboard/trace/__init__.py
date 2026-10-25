"""Trace queries: one facade over a trace file set.

`TraceData` answers the dashboard's questions (info, events, slices, counters,
operations) and `trace_data` caches one instance per file set.
"""

from __future__ import annotations

from .data import TraceData, trace_data

__all__ = ["TraceData", "trace_data"]
