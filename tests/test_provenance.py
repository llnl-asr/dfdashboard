"""Provenance graph extraction and its API route.

The trace below uses both record layouts in one file: the entity API
(EH/ET/ER plus relation arrays) and the legacy producer (prov_entity /
prov_type metadata and cat PROV / PROV_CONT events), so a change to either
path shows up here.
"""

import pytest
from traces import write_trace  # noqa: E402

pytest.importorskip("dftracer.utils")

from dftracer.dashboard.config import Settings  # noqa: E402
from dftracer.dashboard.data.trace import TraceData  # noqa: E402
from dftracer.dashboard.server import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

BASE = 1_000_000


def _write_trace(directory: str) -> str:
    rows = [
        # entity API: entity, type, relation
        {
            "name": "EH",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {
                "id": "e1",
                "type": "relaxed_structure",
                "store": 2,
                "uri": "/p/lustre5/run/best.pdb",
            },
        },
        {
            "name": "ET",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {
                "type": "relaxed_structure",
                "role": 1,
                "description": "a relaxed structure",
            },
        },
        {
            "name": "ER",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {"relation": 18, "subject": "e1", "object": "e2"},
        },
        # entity API: relations straight on the activity event
        {
            "name": "relax",
            "cat": "APP",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 1000,
            "dur": 500,
            "args": {
                "id": 7,
                "activity": "relax",
                "used": ["e1"],
                "generated": ["e2", "e3"],
            },
        },
        # legacy producer: entity, type, activity and an overflow chunk
        {
            "name": "prov_entity:abc123",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {
                "name": "prov_entity:abc123",
                "value": "structure|s1|file|/p/lustre5/run/out.pdb",
            },
        },
        {
            "name": "prov_type:structure",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {
                "name": "prov_type:structure",
                "value": "output|a model structure",
            },
        },
        {
            "name": "fold",
            "cat": "PROV",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 2000,
            "dur": 1000,
            "args": {
                "prov_aid": "a1",
                "prov_activity": "fold",
                "prov_used": "abc123",
                "prov_generated": "def456,ghi789",
                "prov_nused": 1,
                "prov_ngen": 3,
            },
        },
        {
            "name": "fold",
            "cat": "PROV_CONT",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 2000,
            "dur": 1000,
            "args": {"prov_aid": "a1", "prov_used": "", "prov_generated": "jkl012"},
        },
        # file bookkeeping and the I/O the activity causes
        {
            "name": "FH",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {"name": "/p/lustre5/run/best.pdb", "value": "f1"},
        },
        {
            "name": "FH",
            "cat": "dftracer",
            "pid": 1,
            "tid": 1,
            "ph": "M",
            "ts": 0,
            "args": {"name": "/usr/lib/libfoo.so", "value": "f2"},
        },
        {
            "name": "read",
            "cat": "POSIX",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 1100,
            "dur": 10,
            "args": {"fhash": "f1", "ret": 4096},
        },
        {
            "name": "read",
            "cat": "POSIX",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 2200,
            "dur": 10,
            "args": {"fhash": "f1", "ret": 1024},
        },
        {
            "name": "read",
            "cat": "POSIX",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 1200,
            "dur": 10,
            "args": {"fhash": "f2", "ret": 512},
        },
        # outside every activity, so never attributed
        {
            "name": "read",
            "cat": "POSIX",
            "pid": 1,
            "tid": 1,
            "ph": "X",
            "ts": BASE + 9000,
            "dur": 10,
            "args": {"fhash": "f1", "ret": 128},
        },
    ]
    return write_trace(directory, rows, "prov.pfw.gz")


@pytest.fixture
def trace(tmp_path):
    return TraceData(_write_trace(str(tmp_path)), index_dir=str(tmp_path / "idx"))


def test_graph_entities_and_types(trace):
    g = trace.provenance()

    by_hash = {e["hash"]: e for e in g["entities"]}
    assert by_hash["e1"] == {
        "hash": "e1",
        "type": "relaxed_structure",
        "id": "e1",
        "store": "local_disk",
        "uri": "/p/lustre5/run/best.pdb",
        "pids": [1],
    }
    assert by_hash["abc123"]["type"] == "structure"
    assert by_hash["abc123"]["store"] == "file"
    assert by_hash["abc123"]["uri"] == "/p/lustre5/run/out.pdb"

    types = {t["name"]: t for t in g["types"]}
    assert types["relaxed_structure"]["role"] == "input"
    assert types["structure"]["role"] == "output"
    assert types["structure"]["description"] == "a model structure"

    assert g["entity_relations"] == [{"relation": "contains", "subject": "e1", "object": "e2"}]


def test_graph_activities_fold_chunks(trace):
    g = trace.provenance()

    acts = {a["aid"]: a for a in g["activities"]}
    assert len(acts) == 2
    relax = next(a for a in g["activities"] if a["name"] == "relax")
    assert relax["used"] == ["e1"]
    assert relax["generated"] == ["e2", "e3"]

    fold = next(a for a in g["activities"] if a["name"] == "fold")
    assert fold["used"] == ["abc123"]
    assert fold["generated"] == ["def456", "ghi789", "jkl012"]

    assert g["stats"]["cont_events"] == 1
    assert g["stats"]["truncated_activities"] == 0


def test_io_is_attributed_to_the_innermost_activity(trace):
    g = trace.provenance()

    by_op = {(a["aid"], a["path"], a["op"]): a for a in g["accesses"]}
    relax = next(a["aid"] for a in g["activities"] if a["name"] == "relax")
    fold = next(a["aid"] for a in g["activities"] if a["name"] == "fold")

    assert by_op[(relax, "/p/lustre5/run/best.pdb", "read")]["calls"] == 1
    assert by_op[(relax, "/p/lustre5/run/best.pdb", "read")]["bytes"] == 4096
    assert by_op[(fold, "/p/lustre5/run/best.pdb", "read")]["bytes"] == 1024

    # The interpreter library is dropped from the graph, but still attributed.
    assert "/usr/lib/libfoo.so" not in {f["path"] for f in g["files"]}
    assert g["stats"]["files_excluded"] == 1
    assert g["stats"]["io_events"] == 4
    assert g["stats"]["io_attributed"] == 3

    assert g["files"] == [
        {
            "fhash": "f1",
            "path": "/p/lustre5/run/best.pdb",
            "mount": "/p/lustre5",
            "rel": "run/best.pdb",
        }
    ]
    assert g["mounts"] == [{"path": "/p/lustre5", "fstype": "unknown"}]


def test_entity_files_links_uri_to_file(trace):
    g = trace.provenance()
    assert g["entity_files"] == [{"entity": "e1", "fhash": "f1", "path": "/p/lustre5/run/best.pdb"}]


def test_io_can_be_skipped(trace):
    g = trace.provenance(include_io=False)
    assert g["accesses"] == []
    assert g["files"] == []
    assert g["stats"]["io_events"] == 0
    assert g["entities"], "entities come from the first pass only"


def test_all_files_keeps_excluded_paths(trace):
    g = trace.provenance(include_all_files=True)
    assert "/usr/lib/libfoo.so" in {f["path"] for f in g["files"]}
    assert g["stats"]["files_excluded"] == 0


def test_graph_route(tmp_path):
    path = _write_trace(str(tmp_path))
    app = create_app(Settings(trace_paths=[path], index_dir=str(tmp_path / "idx")))
    with TestClient(app) as client:
        res = client.get("/api/prov/graph")
        assert res.status_code == 200
        body = res.json()
        assert body["stats"]["entities"] == 2
        assert body["stats"]["activities"] == 2
        assert body["accesses"]
        no_io = client.get("/api/prov/graph?io=0").json()
        assert no_io["accesses"] == []
        assert no_io["entities"] == body["entities"]
