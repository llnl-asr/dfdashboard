"""Index placement and the per-database locks.

The engine rebuilds a stale index inside a read, and a rebuild racing another
read on the same database fails with "Cannot upgrade RocksDB instance ... while
it is still in use", so reads on one database are serialized while distinct
databases keep reading in parallel.
"""

from __future__ import annotations

import hashlib
import os
import threading


def _index_path_for(index_dir: str, key: str) -> str:
    """One RocksDB directory per unit that a viewer reads on its own.

    The engine keeps its database open for the life of a viewer and never closes
    it. Two handles on one database corrupt it, seen as "Corruption: Mismatch in
    unique ID" or "Cannot upgrade RocksDB instance ... read-only to read-write
    while it is still in use", so a viewer that is read next to another viewer
    needs its own directory.
    """
    if not index_dir:
        return ""
    digest = hashlib.sha1(key.encode()).hexdigest()[:12]
    return os.path.join(index_dir, f"idx-{digest}")


_DB_LOCKS: dict[str, threading.RLock] = {}
_DB_LOCKS_GUARD = threading.Lock()


def _db_lock(index_path: str) -> threading.RLock:
    """The lock for one index database, shared by every viewer that opens it.

    A run trace and the union of runs both index the same file, so they can hold
    two handles on one database; they take the same lock for it, and distinct
    databases never wait for each other.
    """
    with _DB_LOCKS_GUARD:
        lock = _DB_LOCKS.get(index_path)
        if lock is None:
            lock = _DB_LOCKS[index_path] = threading.RLock()
        return lock
