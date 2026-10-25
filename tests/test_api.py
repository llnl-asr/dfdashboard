import io

import pytest
from traces import meta, posix, write_trace  # noqa: E402

pytest.importorskip("dftracer.utils")

from dftracer.dashboard.config import Settings  # noqa: E402
from dftracer.dashboard.server import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _write_trace(directory: str) -> str:
    """A trace with the host and file names the view labels events with."""
    return write_trace(
        directory,
        [
            meta("HH", {"hhash": "hhash0123", "name": "node1", "value": "hhash0123"}),
            meta("FH", {"name": "/scratch/data.bin", "value": "fhash0123"}),
            *posix(5, ret=1024),
        ],
    )


@pytest.fixture
def client(tmp_path):
    path = _write_trace(str(tmp_path))
    settings = Settings(trace_paths=[path], index_dir=str(tmp_path / "idx"))
    with TestClient(create_app(settings)) as c:
        yield c


def test_info(client):
    d = client.get("/api/info").json()
    assert d["file_count"] == 1
    assert d["num_events"] == 5


def test_counters_arrow(client):
    import pyarrow.ipc as ipc

    r = client.get("/api/viz/counters.arrow", params={"begin": 0, "end": 1_000_000, "buckets": 50})
    assert r.status_code == 200
    tbl = ipc.open_stream(io.BytesIO(r.content)).read_all()
    assert tbl.num_rows == 50
    assert set(tbl.column_names) == {"read_bytes", "write_bytes", "ops"}
    assert sum(tbl.column("read_bytes").to_pylist()) == 5 * 1024  # 5 reads, ret=1024


def test_events_arrow(client):
    import pyarrow.ipc as ipc

    r = client.get("/api/viz/events.arrow", params={"begin": 0, "end": 1_000_000})
    assert r.status_code == 200
    tbl = ipc.open_stream(io.BytesIO(r.content)).read_all()
    # metadata (HH/FH) rides along so the view can label hosts and files
    assert tbl.num_rows == 7
    assert [p for p in tbl.column("ph").to_pylist() if p != "M"] == ["X"] * 5


def test_info_totals(client):
    d = client.get("/api/info").json()
    assert d["total_bytes"] == 5 * 1024  # 5 read events, ret=1024
    assert d["io_share"] == 100.0  # all events are POSIX reads


def test_timeline_stream(client):
    import pyarrow.ipc as ipc

    r = client.get("/api/viz/timeline.arrow", params={"begin": 0, "end": 1_000_000, "width": 100})
    assert r.status_code == 200
    reader = ipc.open_stream(io.BytesIO(r.content))
    kinds = set()
    rows = 0
    for batch in reader:
        rows += batch.num_rows
        kinds |= set(batch.column("kind").to_pylist())
    assert rows > 0
    assert kinds <= {0, 1}  # event / density-block markers only


def test_calltree(client):
    d = client.get("/api/viz/calltree", params={"begin": 0, "end": 1_000_000}).json()
    assert d["tree"]["name"] == "all"
    assert d["tree"]["count"] > 0  # 5 read events fold under one "read" frame
    names = {c["name"] for c in d["tree"]["children"]}
    assert "read" in names


def test_openapi_document_lives_under_api(client):
    spec = client.get("/api/openapi.json")
    assert spec.status_code == 200
    assert "/api/info" in spec.json()["paths"]
    assert client.get("/api/docs").status_code == 200


def test_proctree(client):
    nodes = client.get("/api/viz/proctree").json()["nodes"]
    assert nodes[0]["pid"] == 1
    assert nodes[0]["bytes"] == 5 * 1024


def test_bad_params_422(client):
    r = client.get("/api/viz/counters.arrow", params={"begin": 0, "end": 1_000_000, "buckets": 0})
    assert r.status_code == 422  # buckets has ge=1


def test_no_trace_503(tmp_path):
    settings = Settings(trace_paths=[], index_dir=str(tmp_path / "idx"))
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/info").status_code == 503


def test_pipelines_and_task_flow(client):
    import time

    from dftracer.dashboard.analysis.base import Pipeline, Result, RunContext, register_pipeline
    from pydantic import BaseModel

    class EchoParams(BaseModel):
        pass

    class Echo(Pipeline):
        id = "echo_test"
        label = "Echo"
        Params = EchoParams

        async def run(self, ctx: RunContext, params: BaseModel) -> Result:
            return Result(data=42)

    register_pipeline(Echo())

    assert any(p["id"] == "io_summary" for p in client.get("/api/pipelines").json())
    tid = client.post("/api/tasks", json={"pipeline_id": "echo_test"}).json()["task_id"]
    state = ""
    for _ in range(100):
        d = client.get(f"/api/tasks/{tid}").json()
        state = d["state"]
        if state in ("done", "failed"):
            break
        time.sleep(0.02)
    assert state == "done"
    assert d["result"]["data"] == 42


def test_missing_trace_path_errors(tmp_path):
    settings = Settings(
        trace_paths=[str(tmp_path / "nope.pfw.gz")], index_dir=str(tmp_path / "idx")
    )
    with pytest.raises(RuntimeError):
        with TestClient(create_app(settings)):
            pass


def test_viz_columns(client):
    d = client.get("/api/viz/columns").json()
    assert d["ready"] is True
    assert "name" in d["columns"]
    assert "args.ret" in d["columns"]


def test_viz_untimed(client):
    d = client.get("/api/viz/untimed").json()
    assert d["count"] == 2
    assert [e["name"] for e in d["events"]] == ["HH", "FH"]
    assert {e["ph"] for e in d["events"]} == {"M"}
    page = client.get("/api/viz/untimed", params={"limit": 1, "offset": 1}).json()
    assert [e["name"] for e in page["events"]] == ["FH"]


def test_rowset_files_and_hosts(client):
    d = client.get("/api/rowset", params={"name": "files"}).json()
    assert d["names"] == {"fhash0123": "/scratch/data.bin"}
    hosts = client.get("/api/rowset", params={"name": "hosts"}).json()
    assert hosts["names"] == {"hhash0123": "node1"}
    only = client.get("/api/rowset", params={"name": "files", "keys": "nope"}).json()
    assert only["names"] == {}


def test_file_scope(tmp_path):
    first = _write_trace(str(tmp_path))
    second = write_trace(tmp_path, posix(1, pid=2, start=2_000_000, ret=7), "u.pfw.gz")
    app = create_app(Settings(trace_paths=[first, second], index_dir=str(tmp_path / "idx")))
    with TestClient(app) as client:
        assert client.get("/api/info").json()["num_events"] == 6
        scoped = client.get("/api/info", params={"file": second}).json()
        assert scoped["num_events"] == 1
        assert scoped["file_count"] == 2  # n_files is the loaded set, not the scope
        bad = client.get("/api/info", params={"file": "/nope.pfw.gz"})
        assert bad.status_code == 404


def test_errors_carry_a_machine_readable_code(tmp_path):
    # The SPA branches on the code, so a rewording of the detail must not be a
    # breaking change for it.
    app = create_app(
        Settings(trace_paths=[_write_trace(str(tmp_path))], index_dir=str(tmp_path / "idx"))
    )
    with TestClient(app) as client:
        missing = client.get("/api/info", params={"run": "nope"})
        assert missing.status_code == 404
        assert missing.json()["code"] == "no_such_run"
        assert missing.json()["detail"].startswith("no run: ")

        bad = client.get("/api/viz/events.arrow", params={"begin": 0, "end": 10, "query": "&&&"})
        assert bad.status_code in (400, 422)
        if bad.status_code == 400:
            assert bad.json()["code"] == "invalid_query"
