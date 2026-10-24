"""How the watcher learns that a trace tree changed.

`inotify` reports changes that go through *this* kernel. A job on a compute node
that writes to Lustre, NFS, GPFS or SMB never produces an event on the login
node, and no client forwards one. So the filesystem type decides:

    remote mount  -> stat poll, the only thing that works
    local, Linux  -> inotify, with a slow poll underneath as a safety net

The safety poll is not optional. An inotify queue can overflow (`IN_Q_OVERFLOW`)
and a watch can be refused when `max_user_watches` runs out, both of which drop
events silently.
"""

from __future__ import annotations

import ctypes
import logging
import os
import select
import struct
import threading
import time
from typing import Callable, Optional

log = logging.getLogger(__name__)

# Filesystems that do not deliver local inode events for writes from elsewhere.
REMOTE_FS = (
    "nfs",
    "nfs4",
    "lustre",
    "gpfs",
    "cifs",
    "smb3",
    "smbfs",
    "9p",
    "afs",
    "ceph",
    "beegfs",
    "glusterfs",
    "pvfs2",
    "fuse.",
)

POLL = "poll"
EVENTS = "events"

_IN_CREATE = 0x00000100
_IN_MODIFY = 0x00000002
_IN_CLOSE_WRITE = 0x00000008
_IN_MOVED_FROM = 0x00000040
_IN_MOVED_TO = 0x00000080
_IN_DELETE = 0x00000200
_IN_DELETE_SELF = 0x00000400
_IN_ISDIR = 0x40000000
_IN_Q_OVERFLOW = 0x00004000
_WATCH_MASK = (
    _IN_CREATE
    | _IN_MODIFY
    | _IN_CLOSE_WRITE
    | _IN_MOVED_FROM
    | _IN_MOVED_TO
    | _IN_DELETE
    | _IN_DELETE_SELF
)

_EVENT = struct.Struct("iIII")


def parse_mounts(text: str) -> list[tuple[str, str]]:
    """``(mountpoint, fstype)`` from ``/proc/mounts`` style text."""
    out: list[tuple[str, str]] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        mountpoint = parts[1].replace("\\040", " ")
        out.append((mountpoint, parts[2]))
    return out


def mount_type(path: str, text: Optional[str] = None) -> str:
    """The filesystem type of the longest mount that contains ``path``."""
    if text is None:
        try:
            with open("/proc/mounts") as fh:
                text = fh.read()
        except OSError:
            return ""
    target = os.path.abspath(path)
    best = ("", "")
    for mountpoint, fstype in parse_mounts(text):
        if target == mountpoint or target.startswith(mountpoint.rstrip("/") + "/"):
            if len(mountpoint) >= len(best[0]):
                best = (mountpoint, fstype)
    return best[1]


def is_remote(path: str, text: Optional[str] = None) -> bool:
    fstype = mount_type(path, text)
    return any(fstype == r or fstype.startswith(r) for r in REMOTE_FS)


def strategy(path: str, text: Optional[str] = None) -> str:
    """``EVENTS`` only where the kernel can deliver them, else ``POLL``."""
    if not hasattr(ctypes, "CDLL") or not os.path.isdir("/proc"):
        return POLL  # not Linux: no inotify here
    if is_remote(path, text):
        return POLL
    return EVENTS


class Inotify:
    """Recursive inotify on one tree, with a debounce.

    A writer produces many events per file (create, several writes, close), so
    the callback fires once the burst stops rather than per event.
    """

    def __init__(
        self,
        root: str,
        on_change: Callable[[], None],
        debounce: float = 0.3,
        names: tuple[str, ...] = (".pfw.gz", "_SUCCESS", ".done"),
    ) -> None:
        self.root = os.path.abspath(root)
        self.on_change = on_change
        self.debounce = debounce
        self.names = names
        self.running = False
        self._fd = -1
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._dirty = threading.Event()
        self._wd_path: dict[int, str] = {}
        self._libc: Optional[ctypes.CDLL] = None

    def _add(self, directory: str) -> bool:
        assert self._libc is not None
        wd = self._libc.inotify_add_watch(self._fd, directory.encode(), _WATCH_MASK)
        if wd < 0:
            err = ctypes.get_errno()
            log.debug("inotify_add_watch %s failed: %s", directory, os.strerror(err))
            return False
        self._wd_path[wd] = directory
        return True

    def _watch_tree(self, directory: str) -> None:
        for dirpath, dirnames, _ in os.walk(directory):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            self._add(dirpath)

    def start(self) -> bool:
        try:
            libc = ctypes.CDLL("libc.so.6", use_errno=True)
        except OSError:
            return False
        self._libc = libc
        fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if fd < 0:
            return False
        self._fd = fd
        watched = 0
        for dirpath, dirnames, _ in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            watched += 1 if self._add(dirpath) else 0
        if watched == 0:
            os.close(self._fd)
            self._fd = -1
            return False
        self.running = True
        self._thread = threading.Thread(target=self._loop, name="dfd-inotify", daemon=True)
        self._thread.start()
        log.info(
            "inotify on %s (%d director%s)", self.root, watched, "y" if watched == 1 else "ies"
        )
        return True

    def _relevant(self, mask: int, name: str) -> bool:
        if mask & _IN_Q_OVERFLOW:
            return True
        if mask & _IN_ISDIR:
            return True  # a new run directory, or a removed one
        return any(name.endswith(n) for n in self.names)

    def _loop(self) -> None:
        last = 0.0
        clock = time.monotonic
        while not self._stop.is_set():
            try:
                ready, _, _ = select.select([self._fd], [], [], 0.2)
            except (OSError, ValueError):
                break
            if ready:
                try:
                    buf = os.read(self._fd, 64 * 1024)
                except BlockingIOError:
                    continue
                except OSError:
                    break
                offset = 0
                while offset + _EVENT.size <= len(buf):
                    wd, mask, _cookie, length = _EVENT.unpack_from(buf, offset)
                    raw = buf[offset + _EVENT.size : offset + _EVENT.size + length]
                    name = raw.split(b"\0", 1)[0].decode("utf-8", "replace")
                    base = self._wd_path.get(wd, self.root)
                    log.debug("inotify mask=0x%x dir=%s name=%r", mask, base, name)
                    if mask & _IN_ISDIR and mask & (_IN_CREATE | _IN_MOVED_TO) and name:
                        # A new run directory is not watched yet, so files
                        # written into it would be invisible until the safety
                        # poll. Add the watch and pick up what already landed.
                        self._watch_tree(os.path.join(base, name))
                    if self._relevant(mask, name):
                        self._dirty.set()
                        last = clock()
                    offset += _EVENT.size + length
            elif self._dirty.is_set() and clock() - last >= self.debounce:
                self._dirty.clear()
                try:
                    self.on_change()
                except Exception:
                    log.exception("inotify callback failed")
        if self._fd >= 0:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = -1
        self.running = False

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if not self._thread or not self._thread.is_alive():
            self.running = False
