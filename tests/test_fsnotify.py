"""Mount-type detection decides how the watcher learns about changes.

inotify cannot see writes made by another machine, so a remote mount must be
polled. These tests cover the decision and, where the kernel allows it, the
inotify path itself.
"""

import importlib.util
import os
import sys
import time

import pytest

# Import the module by path: the data package pulls numpy, pyarrow and the
# dftracer engine, none of which this module needs.
_spec = importlib.util.spec_from_file_location(
    "dftracer_dashboard_fsnotify",
    os.path.join(
        os.path.dirname(__file__), "..", "python", "dftracer", "dashboard", "data", "fsnotify.py"
    ),
)
assert _spec and _spec.loader
fsnotify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fsnotify)

MOUNTS = """\
/dev/sda1 / ext4 rw,relatime 0 0
/dev/nvme0n1p2 /tmp xfs rw 0 0
10.0.0.5:/scratch /mnt/nfs nfs4 rw,vers=4.2 0 0
@o2ib:@o2ib:/scratch /p/lustre5 lustre rw 0 0
server:/data /mnt/smb cifs rw 0 0
mylaptop:/Users /Users/me/remote fuse.sshfs rw 0 0
/dev/loop0 /snap/core squashfs ro 0 0
"""


def test_mount_type_uses_the_longest_matching_mount():
    assert fsnotify.mount_type("/tmp/traces/x.pfw.gz", MOUNTS) == "xfs"
    assert fsnotify.mount_type("/p/lustre5/job/run", MOUNTS) == "lustre"
    assert fsnotify.mount_type("/mnt/nfs/run", MOUNTS) == "nfs4"
    assert fsnotify.mount_type("/mnt/smb/run", MOUNTS) == "cifs"
    assert fsnotify.mount_type("/", MOUNTS) == "ext4"


def test_remote_mounts_are_polled():
    for path in ("/mnt/nfs/run", "/p/lustre5/job", "/mnt/smb/run", "/Users/me/remote/run"):
        assert fsnotify.strategy(path, MOUNTS) == fsnotify.POLL, path


def test_local_mounts_use_events_on_linux():
    expected = fsnotify.EVENTS if sys.platform.startswith("linux") else fsnotify.POLL
    assert fsnotify.strategy("/tmp/traces", MOUNTS) == expected


def test_unknown_mount_is_not_remote():
    assert not fsnotify.is_remote("/somewhere/odd", MOUNTS)


def _settle(hits: list[float], quiet: float = 0.9) -> int:
    """Wait until no wakeup arrives for ``quiet`` seconds, return the count."""
    last = len(hits)
    deadline = time.time() + quiet
    while time.time() < deadline:
        time.sleep(0.05)
        if len(hits) != last:
            last = len(hits)
            deadline = time.time() + quiet
    return last


def _woke(hits: list[float], action, seconds: float = 5.0) -> bool:
    before = _settle(hits)
    action()
    deadline = time.time() + seconds
    while time.time() < deadline:
        if len(hits) > before:
            return True
        time.sleep(0.02)
    return False


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="inotify is a Linux interface")
def test_inotify_reports_a_new_trace_file(tmp_path):
    hits: list[float] = []
    watcher = fsnotify.Inotify(str(tmp_path), lambda: hits.append(time.time()), debounce=0.05)
    try:
        if not watcher.start():
            pytest.skip("inotify refused in this environment")
        target = tmp_path / "run" / "raw"
        target.mkdir(parents=True)
        _settle(hits)
        assert _woke(hits, lambda: (target / "x.pfw.gz").write_bytes(b"x")), (
            "a new trace file must wake the watcher"
        )
        assert _woke(hits, lambda: (tmp_path / "run" / "_SUCCESS").write_text("")), (
            "a new run directory must be watched, so a marker inside it counts"
        )
    finally:
        watcher.stop()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="inotify is a Linux interface")
def test_inotify_ignores_unrelated_files(tmp_path):
    hits: list[float] = []
    watcher = fsnotify.Inotify(str(tmp_path), lambda: hits.append(time.time()), debounce=0.05)
    try:
        if not watcher.start():
            pytest.skip("inotify refused in this environment")
        _settle(hits)
        assert not _woke(hits, lambda: (tmp_path / "notes.txt").write_text("hello"), 1.5), (
            "a non-trace file must not wake the watcher"
        )
    finally:
        watcher.stop()


def test_watcher_reports_its_strategy(tmp_path, monkeypatch):
    from dftracer.dashboard.data.watch import RunRegistry, Watcher

    reg = RunRegistry(str(tmp_path), str(tmp_path / "idx"))
    monkeypatch.setattr(
        "dftracer.dashboard.data.watch.fsnotify.strategy", lambda root, text=None: fsnotify.POLL
    )
    w = Watcher(reg, interval=0.2, use_events=True)
    w.start()
    time.sleep(0.3)
    w.stop()
    w.join(timeout=3)
    assert not w.is_alive(), "stop must wake the loop, not wait out the safety interval"
    assert reg.snapshot()["watch"] == fsnotify.POLL
    reg.close()


def test_watcher_falls_back_when_inotify_is_refused(tmp_path, monkeypatch):
    from dftracer.dashboard.data.watch import RunRegistry, Watcher

    reg = RunRegistry(str(tmp_path), str(tmp_path / "idx"))
    monkeypatch.setattr(
        "dftracer.dashboard.data.watch.fsnotify.strategy", lambda root, text=None: fsnotify.EVENTS
    )
    monkeypatch.setattr("dftracer.dashboard.data.watch.fsnotify.Inotify.start", lambda self: False)
    w = Watcher(reg, interval=0.2, use_events=True)
    assert w._choose() == fsnotify.EVENTS
    w.start()
    time.sleep(0.3)
    w.stop()
    w.join(timeout=3)
    assert reg.watch_mode == fsnotify.POLL, "a refused inotify must fall back to polling"
    reg.close()


def test_registry_starts_in_poll_mode(tmp_path):
    from dftracer.dashboard.data.watch import RunRegistry

    reg = RunRegistry(str(tmp_path), str(tmp_path / "idx"))
    assert reg.snapshot()["watch"] == fsnotify.POLL
    assert os.path.isdir(str(tmp_path))
    reg.close()
