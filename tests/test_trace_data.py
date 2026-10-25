import gzip
import os

import pytest
from traces import event, meta, multirun, posix, write_trace  # noqa: E402

pytest.importorskip("dftracer.utils")

from dftracer.dashboard.data.trace import TraceData  # noqa: E402


def _write_trace(directory: str) -> str:
    return write_trace(
        directory,
        [meta("HH", {"name": "host"}), *posix(5, ret=1024), event("compute", 1_000_500, 50)],
    )


def test_info_and_events(tmp_path):
    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    info = td.info()
    assert info.num_events == 6
    assert info.global_max_ts > info.global_min_ts

    span = info.global_max_ts - info.global_min_ts
    events = td.events(0, span)
    # plus the HH metadata row, which carries the host name and has no clock
    meta = [e for e in events if e["ph"] == "M"]
    assert [e["name"] for e in meta] == ["HH"]
    timed = [e for e in events if e["ph"] != "M"]
    assert len(timed) == 6
    assert min(e["ts"] for e in timed) == 0  # ts normalized to 0-based
    assert {e["cat"] for e in timed} == {"POSIX", "APP"}

    posix = td.events(0, span, query='cat == "POSIX"')
    assert len(posix) == 5


def test_timeline_folds_all_events(tmp_path):
    import io

    import pyarrow.ipc as ipc

    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))
    span = td.info().global_max_ts - td.info().global_min_ts

    data = b"".join(td.timeline_stream(0, span, width=4, summary=1))
    events = folded = 0
    for b in ipc.open_stream(io.BytesIO(data)):
        for k, c in zip(b.column("kind").to_pylist(), b.column("count").to_pylist()):
            if k == 0:
                events += 1
            else:
                folded += c
    assert events + folded == 6


def test_counters_arrow(tmp_path):
    import io

    import pyarrow.ipc as ipc

    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))
    span = td.info().global_max_ts - td.info().global_min_ts

    tbl = ipc.open_stream(io.BytesIO(td.counters_arrow(0, span, buckets=10))).read_all()
    assert tbl.num_rows == 10
    assert sum(tbl.column("read_bytes").to_pylist()) == 5 * 1024
    assert sum(tbl.column("write_bytes").to_pylist()) == 0


def test_events_arrow_roundtrips(tmp_path):
    import io

    import pyarrow.ipc as ipc

    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))
    span = td.info().global_max_ts - td.info().global_min_ts

    tbl = ipc.open_stream(io.BytesIO(td.events_arrow(0, span))).read_all()
    assert tbl.num_rows == 7  # 6 events plus the HH metadata row
    assert "ts" in tbl.column_names
    assert min(tbl["ts"].to_pylist()) == 0


def test_proctree_has_bytes(tmp_path):
    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    nodes = td.proctree()["nodes"]
    assert len(nodes) == 1
    assert nodes[0]["pid"] == 1
    assert nodes[0]["bytes"] == 5 * 1024
    assert nodes[0]["io_ops"] == 5


def test_breaks_drops_tiny_between_run_gaps(tmp_path):
    # 3 runs of 1s with 10ms idle (~0.33% of the span): too small to be worth a
    # skip marker, so timelapse leaves them as real time rather than adding noise.
    path = multirun(tmp_path)
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    res = td.breaks()
    assert res["gaps"] == []
    assert res["multi_run"] is False


def test_breaks_keeps_significant_gaps(tmp_path):
    # 3 runs of 1s with 300ms idle: past the threshold, so the dead time is skipped.
    path = multirun(tmp_path, gap_us=300_000)
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    res = td.breaks()
    assert res["multi_run"] is True
    assert res["gaps"] == [
        {"begin": 1_000_000, "end": 1_300_000},
        {"begin": 2_300_000, "end": 2_600_000},
    ]


def test_breaks_none_for_continuous_trace(tmp_path):
    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    res = td.breaks()
    assert res["gaps"] == []
    assert res["multi_run"] is False


def test_aggregated_records_keep_their_statistics(tmp_path):
    import io

    import pyarrow.ipc as ipc

    base = 1_000_000
    lines = [
        f'{{"name":"read","cat":"POSIX","pid":1,"tid":1,"ph":3,"ts":{base},"dur":800,'
        '"args":{"dft_cnt":10,"dur_sum":500,"ret":4096}}',
        f'{{"name":"write","cat":"POSIX","pid":1,"tid":1,"ph":1,"ts":{base + 500},{""}'
        '"dur":20,"args":{"ret":8}}',
    ]
    path = os.path.join(str(tmp_path), "agg.pfw.gz")
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")

    td = TraceData(path, index_dir=str(tmp_path / "idx"))
    span = td.info().global_max_ts - td.info().global_min_ts

    events = td.events(0, span)
    agg = [e for e in events if e["name"] == "read"]
    assert len(agg) == 1, "an aggregated record must be reported once"
    assert agg[0]["agg"] is True
    assert agg[0]["count"] == 10
    assert agg[0]["total"] == 500
    assert agg[0]["dur"] == 800
    plain = next(e for e in events if e["name"] == "write")
    assert plain["agg"] is False
    assert plain["count"] == 1

    tbl = ipc.open_stream(io.BytesIO(b"".join(td.timeline_stream(0, span, width=4)))).read_all()
    rows = tbl.to_pydict()
    by_name = {
        n: (a, c, t) for n, a, c, t in zip(rows["name"], rows["agg"], rows["count"], rows["total"])
    }
    assert by_name["read"] == (1, 10, 500.0)
    assert by_name["write"] == (0, 1, 20.0)
