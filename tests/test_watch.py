"""Directory watch: runs from a tree, compact over raw, and the runs API."""

import gzip
import json
import os

import pytest

pytest.importorskip("dftracer.utils")

from fastapi.testclient import TestClient  # noqa: E402

from dfdashboard.config import Settings  # noqa: E402
from dfdashboard.data.watch import (  # noqa: E402
    RunRegistry,
    group_runs,
    pick_set,
    run_root,
    scan_sets,
    tail_record,
)
from dfdashboard.server import create_app  # noqa: E402

BASE = 1_000_000


def _records(pid: int = 1, n: int = 4, end: bool = True) -> list[dict]:
    out = [
        {
            "name": "HH",
            "cat": "dftracer",
            "pid": pid,
            "tid": pid,
            "ph": "M",
            "args": {"hhash": "h" * 8, "name": "node1", "value": "h" * 8},
        }
    ]
    for i in range(n):
        out.append(
            {
                "name": "read",
                "cat": "POSIX",
                "pid": pid,
                "tid": pid,
                "ts": BASE + i * 100,
                "dur": 10,
                "ph": "X",
                "args": {"ret": 1024},
            }
        )
    if end:
        out.append(
            {
                "name": "end",
                "cat": "dftracer",
                "pid": pid,
                "tid": pid,
                "ts": BASE + n * 100,
                "dur": 0,
                "ph": 1,
                "args": {"num_events": n},
            }
        )
    return out


def _write(path: str, recs: list[dict]) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(json.dumps(r) for r in recs) + "\n")
    return path


def _age(*paths: str, seconds: float = 60.0) -> None:
    """Backdate files, as a finished run would be by the time we scan it."""
    import time

    when = time.time() - seconds
    for path in paths:
        os.utime(path, (when, when))


def _registry(root: str, index: str, **kw) -> RunRegistry:
    return RunRegistry(root, index, settle_s=kw.pop("settle_s", 0.0), **kw)


def test_run_root_collapses_format_dirs(tmp_path):
    root = str(tmp_path)
    assert run_root(root, os.path.join(root, "r1")) == "r1"
    assert run_root(root, os.path.join(root, "r1", "raw")) == "r1"
    assert run_root(root, os.path.join(root, "r1", "compact")) == "r1"
    assert run_root(root, os.path.join(root, "a", "b", "raw")) == os.path.join("a", "b")
    assert run_root(root, root) == os.path.basename(root)


def test_compact_set_wins_over_raw(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "run1" / "raw" / "app-abc-app.pfw.gz"), _records())
    _write(str(root / "run1" / "raw" / "app-def-app.pfw.gz"), _records())
    _write(str(root / "run1" / "compact" / "app-1_chunk0.pfw.gz"), _records())

    sets = scan_sets(str(root))
    assert len(sets) == 2
    chosen = pick_set(group_runs(str(root), sets)["run1"])
    assert chosen.compact
    assert chosen.dir.endswith("compact")

    reg = _registry(str(root), str(tmp_path / "idx"))
    assert reg.refresh() is True
    runs = reg.runs()
    assert [r.id for r in runs] == ["run1"]
    assert runs[0].format == "compact"
    assert len(runs[0].files) == 1


def test_raw_only_run_is_read(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "run2" / "raw" / "t1.pfw.gz"), _records())
    _write(str(root / "run2" / "raw" / "t2.pfw.gz"), _records())
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    (run,) = reg.runs()
    assert (run.id, run.format, len(run.files)) == ("run2", "raw", 2)


def test_flat_run_dir_is_a_run(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "20260930_234947" / "a.pfw.gz"), _records())
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    assert [r.id for r in reg.runs()] == ["20260930_234947"]


def test_end_record_marks_a_raw_run_done(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "r" / "a.pfw.gz"), _records(end=True))
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    assert reg.runs()[0].state == "done"


def test_missing_end_record_keeps_a_run_live(tmp_path):
    root = tmp_path / "runs"
    path = _write(str(root / "r" / "a.pfw.gz"), _records(end=False))
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    assert reg.runs()[0].state == "live"

    # No end record and nothing written for a long time: stalled, not done.
    old = 1_000_000_000
    os.utime(path, (old, old))
    reg.refresh()
    assert reg.runs()[0].state == "stalled"


def test_compact_run_is_done_after_settle_quiet(tmp_path):
    root = tmp_path / "runs"
    path = _write(str(root / "r" / "compact" / "app-1_chunk0.pfw.gz"), _records())
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=60.0)
    reg.refresh()
    assert reg.runs()[0].state == "live"
    old = 1_000_000_000
    os.utime(path, (old, old))
    reg.refresh()
    assert reg.runs()[0].state == "done"


def test_tail_record_reads_the_end_record(tmp_path):
    done = _write(str(tmp_path / "done.pfw.gz"), _records(end=True))
    live = _write(str(tmp_path / "live.pfw.gz"), _records(end=False))
    rec = tail_record(done)
    assert rec is not None and rec["name"] == "end"
    assert rec["args"]["num_events"] == 4
    rec = tail_record(live)
    assert rec is not None and rec["name"] == "read"


def test_new_file_bumps_seq_and_version(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "r" / "raw" / "a.pfw.gz"), _records())
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    seq, version = reg.seq, reg.runs()[0].version
    assert reg.refresh() is False, "a scan with no change must not report one"
    assert (reg.seq, reg.runs()[0].version) == (seq, version)

    _write(str(root / "r" / "raw" / "b.pfw.gz"), _records())
    assert reg.refresh() is True
    assert reg.seq == seq + 1
    assert reg.runs()[0].version == version + 1
    assert len(reg.runs()[0].files) == 2


def test_a_finished_run_appears_and_disappears(tmp_path):
    root = tmp_path / "runs"
    reg = _registry(str(root), str(tmp_path / "idx"))
    os.makedirs(str(root), exist_ok=True)
    reg.refresh()
    assert reg.runs() == []
    _write(str(root / "late" / "raw" / "a.pfw.gz"), _records())
    reg.refresh()
    assert [r.id for r in reg.runs()] == ["late"]
    seq = reg.seq
    import shutil

    shutil.rmtree(str(root / "late"))
    reg.refresh()
    assert reg.runs() == []
    assert reg.seq == seq + 1


def test_band_order_and_file_run_index(tmp_path):
    root = tmp_path / "runs"
    # run ids are arbitrary, so order must come from the data, not the name
    _write(str(root / "z-last" / "a.pfw.gz"), _records(pid=1))
    late = _records(pid=1)
    for r in late:
        if "ts" in r:
            r["ts"] += 10_000
    _write(str(root / "a-first" / "b.pfw.gz"), late)
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    for run in reg.runs():
        reg.describe(run.id)  # fills first_ts
    # Names are deliberately inverted against the clock: z-last starts first.
    assert reg.order() == ["z-last", "a-first"], "order is by first timestamp, not name"
    trace = reg.trace()
    assert trace is not None
    assert sorted(set(trace.file_runs.values())) == [0, 1]

    import io

    import pyarrow.ipc as ipc

    span = trace.info()
    rows = ipc.open_stream(
        io.BytesIO(b"".join(trace.timeline_stream(0.0, float(span.global_max_ts), 50)))
    ).read_all()
    assert "run" in rows.schema.names
    assert set(rows.column("run").to_pylist()) <= {0, 1}


def test_change_listener_fires_only_on_change(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "r" / "raw" / "a.pfw.gz"), _records())
    reg = _registry(str(root), str(tmp_path / "idx"))
    seen: list[int] = []
    drop = reg.add_listener(seen.append)
    reg.refresh()
    assert seen == [reg.seq], "a change must notify the subscriber"
    reg.refresh()
    assert len(seen) == 1, "a scan with no change must stay quiet"
    drop()
    _write(str(root / "r" / "raw" / "b.pfw.gz"), _records())
    reg.refresh()
    assert len(seen) == 1, "an unsubscribed listener must not be called"


def test_runs_api_and_stream(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "run1" / "raw" / "a.pfw.gz"), _records(pid=1))
    _write(str(root / "run1" / "compact" / "app-1_chunk0.pfw.gz"), _records(pid=1))
    _write(str(root / "run2" / "raw" / "b.pfw.gz"), _records(pid=2))
    settings = Settings(watch_root=str(root), index_dir=str(tmp_path / "idx"))
    with TestClient(create_app(settings)) as c:
        body = c.get("/api/runs").json()
        assert body["seq"] >= 1
        got = {r["id"]: r for r in body["runs"]}
        assert sorted(got) == ["run1", "run2"]
        assert got["run1"]["format"] == "compact"
        assert got["run2"]["format"] == "raw"
        assert got["run2"]["events"] > 0

        # /api/info follows the run scope, so file_count is the run's files.
        info = c.get("/api/info?run=run1").json()
        assert info["file_count"] == 1
        assert c.get("/api/info?run=nope").status_code == 404

        with c.stream("GET", "/api/stream") as resp:
            assert resp.status_code == 200
            lines = []
            for line in resp.iter_lines():
                lines.append(line)
                if len(lines) >= 2:
                    break
        assert lines[0] == "event: runs"
        assert json.loads(lines[1][len("data: ") :])["runs"]


def test_marker_file_marks_a_compact_set_done(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "r" / "compact" / "app-1_chunk0.pfw.gz"), _records())
    open(str(root / "r" / "compact" / "_SUCCESS"), "w").close()
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=3600.0)
    reg.refresh()
    assert reg.runs()[0].format == "compact"
    assert reg.runs()[0].state == "done", "a marker settles it without waiting"


def test_marker_on_the_run_dir_marks_every_format_done(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "r" / "raw" / "a.pfw.gz"), _records(end=False))
    open(str(root / "r" / "_SUCCESS"), "w").close()
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    run = reg.runs()[0]
    assert (run.state, run.reason) == ("done", "marker")


def test_state_reports_why(tmp_path):
    root = tmp_path / "runs"
    r = _write(str(root / "raw-run" / "a.pfw.gz"), _records(end=True))
    _write(str(root / "split-run" / "compact" / "app-1_chunk0.pfw.gz"), _records())
    _age(r)  # the split set is still being written, so nothing is settled there
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=3600.0)
    reg.refresh()
    got = {r.id: (r.state, r.reason) for r in reg.runs()}
    assert got["raw-run"] == ("done", "end-record")
    assert got["split-run"] == ("live", "writing")


def test_custom_marker_name(tmp_path):
    root = tmp_path / "runs"
    _write(str(root / "r" / "compact" / "app-1_chunk0.pfw.gz"), _records())
    open(str(root / "r" / "compact" / "DONE"), "w").close()
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=3600.0, markers=["DONE"])
    reg.refresh()
    assert (reg.runs()[0].state, reg.runs()[0].reason) == ("done", "marker")


def test_compact_set_is_verified_against_raw(tmp_path):
    root = tmp_path / "runs"
    a = _records(pid=1, n=4)
    b = _records(pid=2, n=4)
    ra = _write(str(root / "r" / "raw" / "a.pfw.gz"), a)
    rb = _write(str(root / "r" / "raw" / "b.pfw.gz"), b)
    # dftracer_split copies the records, including each source end record.
    ck = _write(str(root / "r" / "compact" / "app-1_chunk0.pfw.gz"), a + b)
    _age(ra, rb, ck)
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=3600.0)
    reg.refresh()
    run = reg.runs()[0]
    assert run.format == "compact"
    assert (run.state, run.reason) == ("done", "verified")


def test_compact_set_short_of_a_chunk_is_not_done(tmp_path):
    root = tmp_path / "runs"
    a = _records(pid=1, n=4)
    b = _records(pid=2, n=4)
    ra = _write(str(root / "r" / "raw" / "a.pfw.gz"), a)
    rb = _write(str(root / "r" / "raw" / "b.pfw.gz"), b)
    ck = _write(str(root / "r" / "compact" / "app-1_chunk0.pfw.gz"), a)  # b still splitting
    _age(ra, rb, ck)
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=3600.0)
    reg.refresh()
    assert (reg.runs()[0].state, reg.runs()[0].reason) == ("live", "writing")


def test_unfinished_raw_keeps_the_compact_set_live(tmp_path):
    root = tmp_path / "runs"
    ra = _write(str(root / "r" / "raw" / "a.pfw.gz"), _records(pid=1, n=4, end=False))
    ck = _write(str(root / "r" / "compact" / "app-1_chunk0.pfw.gz"), _records(pid=1, n=4))
    _age(ra, ck)
    reg = RunRegistry(str(root), str(tmp_path / "idx"), settle_s=3600.0)
    reg.refresh()
    assert (reg.runs()[0].state, reg.runs()[0].reason) == ("live", "writing")


def test_end_check_falls_back_to_the_engine(tmp_path, monkeypatch):
    root = tmp_path / "runs"
    _write(str(root / "r" / "a.pfw.gz"), _records(end=True))
    import dfdashboard.data.watch as watch

    monkeypatch.setattr(watch, "tail_record", lambda *a, **k: None)
    reg = _registry(str(root), str(tmp_path / "idx"))
    reg.refresh()
    assert reg.runs()[0].state == "done", "the engine must answer when the peek fails"
