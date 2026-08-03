import gzip
import io
import os

import pytest

pytest.importorskip("dftracer.utils")
pytest.importorskip("polars")

from fastapi.testclient import TestClient  # noqa: E402

from dfdashboard.config import Settings  # noqa: E402
from dfdashboard.server import create_app  # noqa: E402


def _write_trace(directory: str) -> str:
    lines = ["["]
    base = 1_000_000
    for i in range(5):
        lines.append(
            f'{{"name":"read","cat":"POSIX","pid":1,"tid":1,"ts":{base + i * 100},'
            f'"dur":10,"ph":"X","args":{{"ret":1024}}}}'
        )
    path = os.path.join(directory, "t.pfw.gz")
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


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
    assert tbl.num_rows == 5


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

    from pydantic import BaseModel

    from dfdashboard.analysis.base import Pipeline, Result, RunContext, register_pipeline

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
