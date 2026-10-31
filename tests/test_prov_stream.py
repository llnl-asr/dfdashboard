"""Provenance read while the service writes the trace: whole gzip members only, and I/O attributed in either arrival order."""

import gzip
import json

from dftracer.dashboard.data.prov_stream import ProvFeed, Tail, expand, has_whole_member


def member(*records):
    return gzip.compress("".join(json.dumps(r) + "\n" for r in records).encode())


def eh(i, type_="t", uri=""):
    return {"name": "EH", "cat": "dftracer", "ph": 4, "pid": 1, "args": {"id": i, "type": type_, "store": 2, "uri": uri}}


def act(ts, dur=20, name="step", **rel):
    return {"name": name, "cat": "moirai", "ph": 1, "pid": 1, "ts": ts, "dur": dur, "args": {"relations": rel}}


def fh(path, h):
    return {"name": "FH", "cat": "dftracer", "ph": 4, "pid": 1, "args": {"name": path, "value": h}}


def io(name, ts, h, **a):
    return {"name": name, "cat": "POSIX", "ph": 1, "pid": 1, "ts": ts, "dur": 1, "args": {"fhash": h, **a}}


def test_tail_commits_whole_members_only(tmp_path):
    f = tmp_path / "t.pfw.gz"
    one, two = member(act(1)), member(act(2), act(3))
    f.write_bytes(one + two[:8])
    t = Tail([str(tmp_path)])
    assert [r["ts"] for r in t.poll()] == [1]
    assert t.poll() == []
    with open(f, "ab") as fh_:
        fh_.write(two[8:])
    assert [r["ts"] for r in t.poll()] == [2, 3]


def test_tail_waits_at_a_hole(tmp_path):
    f = tmp_path / "t.pfw.gz"
    a, b = member(act(1)), member(act(2))
    f.write_bytes(b"\0" * len(a) + b)
    t = Tail([str(tmp_path)])
    assert t.poll() == []
    with open(f, "r+b") as fh_:
        fh_.write(a)
    assert [r["ts"] for r in t.poll()] == [1, 2]


def test_expand_finds_new_files(tmp_path):
    assert expand(str(tmp_path)) == []
    (tmp_path / "a.pfw.gz").write_bytes(member(act(1)))
    assert len(expand(str(tmp_path))) == 1


def test_feed_streams_what_each_record_adds(tmp_path):
    f = tmp_path / "t.pfw.gz"
    f.write_bytes(member(eh("a", uri="/d/a"), act(10, used=["a"])))
    feed = ProvFeed([str(tmp_path)])
    assert feed.poll() == 2
    snap = feed.snapshot()
    assert len(snap["entities"]) == 1 and snap["activities"][0]["used"] == ["a"]
    with open(f, "ab") as fh_:
        fh_.write(member(eh("b"), act(40, generated=["b"])))
    feed.poll()
    items, seq = feed.since(snap["seq"])
    assert [i["kind"] for i in items] == ["entity", "activity"] and seq == feed.seq


def test_io_before_its_activity_goes_to_the_innermost(tmp_path):
    (tmp_path / "t.pfw.gz").write_bytes(member(fh("/d/a", "f"), io("write", 25, "f", ret=9), act(20, 10, "inner"), act(10, 40, "outer"), io("read", 26, "f", ret=1)))
    feed = ProvFeed([str(tmp_path)])
    feed.poll()
    acc = {(a["aid"], a["op"]): (a["calls"], a["bytes"]) for a in feed.accesses()}
    assert acc == {("1:20", "write"): (1, 9), ("1:20", "read"): (1, 1)}


def test_system_files_are_left_out_and_a_late_name_still_shows(tmp_path):
    (tmp_path / "t.pfw.gz").write_bytes(member(fh("/usr/lib/x.py", "p"), act(10), io("read", 12, "p"), io("open64", 13, "f"), fh("/d/late", "f")))
    feed = ProvFeed([str(tmp_path)])
    feed.poll()
    assert [a["path"] for a in feed.accesses()] == ["/d/late"]


def test_stream_route_sends_a_snapshot_then_deltas(tmp_path):
    from dftracer.dashboard.api import prov as P
    (tmp_path / "t.pfw.gz").write_bytes(member(eh("a"), act(10, used=["a"])))
    feeds = {}
    feed = P.feed_for(feeds, "r", [str(tmp_path)])
    assert feed is P.feed_for(feeds, "r", [str(tmp_path)])
    assert P.feed_for(feeds, "none", []) is None


def test_a_file_opens_only_once_it_has_a_whole_member(tmp_path):
    f = tmp_path / "t.pfw.gz"
    whole = member(act(1))
    f.write_bytes(whole[:6])
    assert not has_whole_member(str(f))
    f.write_bytes(whole)
    assert has_whole_member(str(f))
