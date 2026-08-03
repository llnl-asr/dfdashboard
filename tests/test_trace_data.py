import gzip
import os

import pytest

pytest.importorskip("dftracer.utils")
pytest.importorskip("polars")

from dfdashboard.data.trace import TraceData  # noqa: E402


def _write_trace(directory: str) -> str:
    lines = [
        "[",
        '{"name":"HH","cat":"dftracer","pid":1,"tid":1,"ph":"M","args":{"name":"host"}}',
    ]
    base = 1_000_000
    for i in range(5):
        lines.append(
            f'{{"name":"read","cat":"POSIX","pid":1,"tid":1,"ts":{base + i * 100},'
            f'"dur":10,"ph":"X","args":{{"ret":1024}}}}'
        )
    lines.append(
        f'{{"name":"compute","cat":"APP","pid":1,"tid":1,"ts":{base + 500},'
        f'"dur":50,"ph":"X","args":{{}}}}'
    )
    path = os.path.join(directory, "t.pfw.gz")
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def test_info_and_events(tmp_path):
    path = _write_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    info = td.info()
    assert info.num_events == 6
    assert info.global_max_ts > info.global_min_ts

    span = info.global_max_ts - info.global_min_ts
    events = td.events(0, span)
    assert len(events) == 6
    assert min(e["ts"] for e in events) == 0  # ts normalized to 0-based
    assert {e["cat"] for e in events} == {"POSIX", "APP"}

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
    assert tbl.num_rows == 6
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


def _write_multirun_trace(directory, num_runs=3, run_us=1_000_000, gap_us=10_000):
    base = 1_000_000_000
    lines = ["["]
    for r in range(num_runs):
        pid = 100 + r
        start = base + r * (run_us + gap_us)
        end = start + run_us
        lines.append(
            f'{{"id":1,"pid":{pid},"tid":{pid * 10},"name":"start","cat":"dftracer",'
            f'"ph":"X","ts":{start},"dur":1,"args":{{"exec_hash":"app","ppid":1}}}}'
        )
        for i in range(3):
            lines.append(
                f'{{"id":1,"pid":{pid},"tid":{pid * 10},"name":"read","cat":"POSIX",'
                f'"ph":"X","ts":{start + i * (run_us // 4)},"dur":100,"args":{{"ret":1024}}}}'
            )
        lines.append(
            f'{{"id":1,"pid":{pid},"tid":{pid * 10},"name":"end","cat":"dftracer",'
            f'"ph":"X","ts":{end},"dur":1,"args":{{"num_events":3}}}}'
        )
    lines.append("]")
    path = os.path.join(directory, "multirun.pfw.gz")
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def test_breaks_drops_tiny_between_run_gaps(tmp_path):
    # 3 runs of 1s with 10ms idle (~0.33% of the span): too small to be worth a
    # skip marker, so timelapse leaves them as real time rather than adding noise.
    path = _write_multirun_trace(str(tmp_path))
    td = TraceData(path, index_dir=str(tmp_path / "idx"))

    res = td.breaks()
    assert res["gaps"] == []
    assert res["multi_run"] is False


def test_breaks_keeps_significant_gaps(tmp_path):
    # 3 runs of 1s with 300ms idle: past the threshold, so the dead time is skipped.
    path = _write_multirun_trace(str(tmp_path), gap_us=300_000)
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
