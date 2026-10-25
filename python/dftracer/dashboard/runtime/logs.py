"""Log hub: captures Python logging and dftracer-utils C++ stderr into a
bounded ring buffer, streamed to the log console.

Native C++ logs only reach stderr, so fd 2 is teed through a pipe.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from collections import deque
from typing import Optional

_NATIVE_RE = re.compile(r"^\[[\d\-:. ]+\]\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL)\s+(.*)$")
_LEVELNO = {
    "TRACE": 5,
    "DEBUG": 10,
    "INFO": 20,
    "WARN": 30,
    "WARNING": 30,
    "ERROR": 40,
    "CRITICAL": 50,
}


def _group_for(name: str) -> str:
    if name.startswith("dftracer.dashboard"):
        return "dftracer.dashboard"
    if name.startswith(("distributed", "dask")):
        return "dask"
    if name.startswith(("uvicorn", "fastapi", "starlette")):
        return "server"
    if name.startswith("dftracer"):
        return "dftracer-utils"
    return name.split(".")[0] or "root"


def _safe_put(q: asyncio.Queue, rec: dict) -> None:
    try:
        q.put_nowait(rec)
    except asyncio.QueueFull:
        pass


class LogHub:
    def __init__(self, maxlen: int = 2000) -> None:
        self._buf: deque[dict] = deque(maxlen=maxlen)
        self._subs: set[asyncio.Queue] = set()
        self._seq = 0
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._handler: Optional[logging.Handler] = None
        self._stderr_started = False

    def install(self) -> None:
        # Idempotent (Logger.addHandler dedups): call again after uvicorn has
        # reconfigured its own loggers to re-attach and capture its records.
        if self._handler is None:
            self._handler = _HubHandler(self)
            self._handler.setLevel(logging.DEBUG)
        root = logging.getLogger()
        if root.level == logging.NOTSET or root.level > logging.INFO:
            root.setLevel(logging.INFO)
        root.addHandler(self._handler)
        # These configure their own non-propagating handlers, so attach directly.
        for n in ("uvicorn", "uvicorn.access", "uvicorn.error", "distributed", "dask"):
            logging.getLogger(n).addHandler(self._handler)
        logging.getLogger("dftracer.dashboard").setLevel(logging.DEBUG)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publish(
        self, level: str, levelno: int, group: str, source: str, msg: str, ts: float
    ) -> None:
        with self._lock:
            rec = {
                "seq": self._seq,
                "ts": ts,
                "level": level,
                "levelno": levelno,
                "group": group,
                "source": source,
                "msg": msg,
            }
            self._seq += 1
            self._buf.append(rec)
            subs = tuple(self._subs)
        loop = self._loop
        if loop is not None:
            for q in subs:
                loop.call_soon_threadsafe(_safe_put, q, rec)

    def snapshot(self, limit: int = 2000) -> list[dict]:
        with self._lock:
            return list(self._buf)[-limit:]

    def groups(self) -> list[str]:
        with self._lock:
            return sorted({r["group"] for r in self._buf})

    def add_subscriber(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subs.add(q)
        return q

    def remove_subscriber(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def close(self) -> None:
        # Wake every stream with a None sentinel so SSE generators exit at once
        # instead of blocking shutdown until the graceful-timeout force-close.
        # Safe to call from a signal handler: delivery goes through the loop.
        with self._lock:
            subs = tuple(self._subs)
        loop = self._loop
        for q in subs:
            if loop is not None:
                loop.call_soon_threadsafe(_safe_put, q, None)

    def start_stderr_capture(self) -> None:
        if self._stderr_started:
            return
        try:
            orig = os.dup(2)
            r_fd, w_fd = os.pipe()
            os.dup2(w_fd, 2)
            os.close(w_fd)
        except Exception:
            return
        self._stderr_started = True
        threading.Thread(target=self._reader, args=(r_fd, orig), daemon=True).start()

    def _reader(self, r_fd: int, orig_fd: int) -> None:
        buf = b""
        while True:
            try:
                data = os.read(r_fd, 4096)
            except OSError:
                break
            if not data:
                break
            try:
                os.write(orig_fd, data)  # keep the real console output intact
            except OSError:
                pass
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                m = _NATIVE_RE.match(line.decode("utf-8", "replace").strip())
                if not m:
                    continue  # Python-logging lines are captured via the handler
                level = "WARNING" if m.group(1).upper() == "WARN" else m.group(1).upper()
                self.publish(
                    level,
                    _LEVELNO.get(level, 20),
                    "dftracer-utils",
                    "native",
                    m.group(2),
                    time.time(),
                )


class _HubHandler(logging.Handler):
    def __init__(self, hub: LogHub) -> None:
        super().__init__()
        self._hub = hub

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._hub.publish(
                record.levelname,
                record.levelno,
                _group_for(record.name),
                record.name,
                record.getMessage(),
                record.created,
            )
        except Exception:
            pass


_HUB: Optional[LogHub] = None


def get_hub() -> LogHub:
    global _HUB
    if _HUB is None:
        _HUB = LogHub()
    return _HUB
