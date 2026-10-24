#!/usr/bin/env python3
"""Write a synthetic trace tree the way a running application would.

Each ``--files`` is one process writing its own ``.pfw.gz`` in append mode, so
gzip members land while the dashboard watches. A run stops with the ``end``
record the real writer emits, and can then be split into a compact set and
marked done, which is the whole lifecycle the watcher recognises.

    scripts/stream_demo.py --root /tmp/streams --runs 2 --split

Runs start ``--run-gap`` seconds apart, every file appends ``--batch`` events
per ``--interval`` seconds, so the second run appears while the first is still
being written.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import random
import shutil
import subprocess
import sys
import threading
import time
from typing import IO


def _metadata(pid: int, host: str, files: list[str]) -> list[dict]:
    out = [
        {
            "name": "HH",
            "cat": "dftracer",
            "pid": pid,
            "tid": pid,
            "ph": 4,
            "args": {"hhash": host, "name": host, "value": host},
        },
        {
            "name": "thread_name",
            "cat": "dftracer",
            "pid": pid,
            "tid": pid,
            "ph": 4,
            "args": {"hhash": host, "name": str(pid), "value": "thread_name"},
        },
    ]
    for path in files:
        out.append(
            {
                "name": "FH",
                "cat": "dftracer",
                "pid": pid,
                "tid": pid,
                "ph": 4,
                "args": {"fhash": path, "name": path, "value": path},
            }
        )
    return out


def _event(
    pid: int,
    index: int,
    host: str,
    paths: list[str],
    rnd: random.Random,
    base: int,
    gap_us: int,
) -> list[dict]:
    ts = base + index * gap_us
    path = rnd.choice(paths)
    kind = rnd.choice(["read", "read", "write", "open", "fopen"])
    dur = rnd.randint(20, 900)
    size = rnd.choice([4096, 65536, 1 << 20, 8 << 20])
    recs = [
        {
            "name": kind,
            "cat": "POSIX" if kind in ("read", "write", "open") else "STDIO",
            "pid": pid,
            "tid": pid,
            "ts": ts,
            "dur": dur,
            "ph": 1,
            "args": {"ret": size, "fhash": path, "hhash": host, "offset": index * 4096},
        }
    ]
    if index % 50 == 0:
        recs.append(
            {
                "name": "app_work",
                "cat": "APP",
                "pid": pid,
                "tid": pid,
                "ts": ts + dur,
                "dur": rnd.randint(500, 20_000),
                "ph": 1,
                "args": {},
            }
        )
    if index % 25 == 0:
        recs.append(
            {
                "name": "mem_used",
                "cat": "profile",
                "pid": pid,
                "tid": pid,
                "ts": ts,
                "ph": 2,
                "args": {"value": 512 + rnd.randint(0, 256)},
            }
        )
    return recs


class Writer:
    def __init__(self, path: str, handle: IO[str]) -> None:
        self.path = path
        self.handle = handle
        self.events = 0

    def write(self, records: list[dict]) -> None:
        for rec in records:
            self.handle.write(json.dumps(rec) + "\n")
        self.handle.flush()
        self.events += sum(1 for r in records if r.get("ph") in (1, 2))


def run(
    root: str,
    name: str,
    files: int,
    batch: int,
    total: int,
    interval: float,
    split: bool,
    seed: int,
    gap_us: int,
) -> None:
    rnd = random.Random(seed)
    # Real wall clock, as a real writer stamps it. Two runs started minutes
    # apart must not share a span.
    base = int(time.time() * 1_000_000)
    # A new job gets new processes: the pid block follows the start time, so two
    # runs never reuse a pid as they would in a real scheduler.
    pid_base = 200_000 + (base // 1_000_000) % 700_000
    # A job spans several nodes; one host per run would hide that.
    hosts = [f"node{i + 1}" for i in range(files)]
    run_dir = os.path.join(root, name)
    raw_dir = os.path.join(run_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    paths = [f"/scratch/{name}/data{i}.bin" for i in range(4)]

    writers: list[Writer] = []
    for i in range(files):
        pid = pid_base + i
        path = os.path.join(raw_dir, f"{name}-{pid}-app.pfw.gz")
        handle = gzip.open(path, "at")
        writer = Writer(path, handle)  # type: ignore[arg-type]
        writer.write(_metadata(pid, hosts[i], paths))
        writers.append(writer)

    done = 0
    while done < total:
        for i, writer in enumerate(writers):
            pid = pid_base + i
            n = min(batch, total - done)
            writer.write(
                [
                    e
                    for k in range(n)
                    for e in _event(pid, done + k, hosts[i], paths, rnd, base, gap_us)
                ]
            )
        done += batch
        if done < total:
            time.sleep(interval)

    for i, writer in enumerate(writers):
        pid = pid_base + i
        writer.handle.write(
            json.dumps(
                {
                    "name": "end",
                    "cat": "dftracer",
                    "pid": pid,
                    "tid": pid,
                    "ts": base + done * gap_us + 1,
                    "dur": 0,
                    "ph": 1,
                    "args": {"num_events": writer.events},
                }
            )
            + "\n"
        )
        writer.handle.close()
        del pid

    print(f"[{name}] raw done: {files} files, {total} events each", flush=True)

    if split:
        out = os.path.join(run_dir, "compact")
        shutil.rmtree(out, ignore_errors=True)
        local = os.path.join(os.path.dirname(sys.executable), "dftracer_split")
        binary = local if os.path.exists(local) else shutil.which("dftracer_split")
        if binary is None:
            print(f"[{name}] dftracer_split not on PATH, skipping split", flush=True)
            return
        subprocess.run(
            [binary, "-d", raw_dir, "-o", out, "--compress"],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        open(os.path.join(run_dir, "_SUCCESS"), "w").close()
        print(f"[{name}] compact written, _SUCCESS dropped", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--files", type=int, default=4, help="processes per run")
    ap.add_argument("--batch", type=int, default=20, help="events per file per tick")
    ap.add_argument("--total", type=int, default=600, help="events per file")
    ap.add_argument("--interval", type=float, default=0.3)
    ap.add_argument("--run-gap", type=float, default=6.0, help="seconds between run starts")
    ap.add_argument("--split", action="store_true", help="split each run and mark it done")
    ap.add_argument(
        "--event-gap-ms",
        type=float,
        default=20.0,
        help="simulated time between events, so a run spans a visible width",
    )
    args = ap.parse_args()

    os.makedirs(args.root, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    threads = []
    for i in range(args.runs):
        # A job id, so a root that gathers several invocations has distinct run
        # ids instead of a row of "<timestamp>_run0" entries.
        name = f"{stamp}_job{stamp[9:]}{i}"
        t = threading.Thread(
            target=run,
            args=(
                args.root,
                name,
                args.files,
                args.batch,
                args.total,
                args.interval,
                args.split,
                i + 1,
                int(args.event_gap_ms * 1000),
            ),
            name=name,
            daemon=False,
        )
        t.start()
        threads.append(t)
        if i + 1 < args.runs:
            print(f"waiting {args.run_gap}s before starting the next run", flush=True)
            time.sleep(args.run_gap)
    for t in threads:
        t.join()
    print("all runs finished", flush=True)


if __name__ == "__main__":
    main()
