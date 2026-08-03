import { tableFromIPC } from "@uwdata/flechette";
import { decompress } from "fzstd";
import type { ProcTreeNode } from "../data/types";
import type { TimelineBatch } from "./slices";

export function inflate(bytes: Uint8Array): Uint8Array {
  // fzstd returns a view at a non-8-aligned byteOffset; Arrow's int64 columns
  // need an 8-byte-aligned buffer, so copy into a fresh offset-0 buffer.
  return bytes.byteLength ? new Uint8Array(decompress(bytes)) : bytes;
}

export function parseTimelineIpc(bytes: Uint8Array): TimelineBatch {
  const events: TimelineBatch["events"] = [];
  const density: TimelineBatch["density"] = [];
  if (bytes.byteLength === 0) return { events, density };

  const table = tableFromIPC(bytes);
  const n = table.numRows;
  const col = (name: string): unknown[] => (table.getChild(name)?.toArray() as unknown[]) ?? [];
  const kind = col("kind");
  const name = col("name");
  const cat = col("cat");
  const ph = col("ph");
  const pid = col("pid");
  const tid = col("tid");
  const ts = col("ts");
  const dur = col("dur");
  const depth = col("depth");
  const args = col("args");
  const count = col("count");
  const total = col("total");

  for (let i = 0; i < n; i++) {
    if (Number(kind[i]) === 0) {
      let parsed: Record<string, unknown> | undefined;
      const raw = args[i] ? String(args[i]) : "";
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = undefined;
        }
      }
      events.push({
        name: String(name[i] ?? ""),
        cat: String(cat[i] ?? ""),
        ph: String(ph[i] ?? "X"),
        pid: Number(pid[i] ?? 0),
        tid: Number(tid[i] ?? 0),
        ts: Number(ts[i] ?? 0),
        dur: Number(dur[i] ?? 0),
        depth: Number(depth[i] ?? 0),
        args: parsed,
      });
    } else {
      density.push({
        name: String(name[i] ?? ""),
        pid: Number(pid[i] ?? 0),
        tid: Number(tid[i] ?? 0),
        ts: Number(ts[i] ?? 0),
        dur: Number(dur[i] ?? 0),
        count: Number(count[i] ?? 0),
        total: Number(total[i] ?? 0),
        depth: Number(depth[i] ?? 0),
      });
    }
  }
  return { events, density };
}

export function parseProctreeIpc(bytes: Uint8Array): ProcTreeNode[] {
  const out: ProcTreeNode[] = [];
  if (bytes.byteLength === 0) return out;
  const table = tableFromIPC(bytes);
  const n = table.numRows;
  const col = (name: string): unknown[] => (table.getChild(name)?.toArray() as unknown[]) ?? [];
  const pid = col("pid");
  const parent = col("parent");
  const spawn = col("spawn_ts");
  const first = col("first_ts");
  const host = col("host");
  const rank = col("rank");
  const bytes_ = col("bytes");
  const ioOps = col("io_ops");
  const ioBusy = col("io_busy");
  for (let i = 0; i < n; i++) {
    out.push({
      pid: Number(pid[i] ?? 0),
      parent: Number(parent[i] ?? -1),
      spawn_ts: Number(spawn[i] ?? 0),
      first_ts: Number(first[i] ?? 0),
      host: host[i] ? String(host[i]) : "",
      rank: rank[i] != null ? String(rank[i]) : "",
      bytes: Number(bytes_[i] ?? 0),
      io_ops: Number(ioOps[i] ?? 0),
      io_busy: Number(ioBusy[i] ?? 0),
    });
  }
  return out;
}

export function parseCountersIpc(bytes: Uint8Array): { read: number[]; write: number[] } {
  if (bytes.byteLength === 0) return { read: [], write: [] };
  const table = tableFromIPC(bytes);
  return {
    read: Array.from((table.getChild("read_bytes")?.toArray() as ArrayLike<number>) ?? [], Number),
    write: Array.from(
      (table.getChild("write_bytes")?.toArray() as ArrayLike<number>) ?? [],
      Number,
    ),
  };
}
