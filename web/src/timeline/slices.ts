import type { RecordBatch } from "apache-arrow";
import type { DensityBlock, TraceEvent } from "../data/types";

export interface TimelineBatch {
  events: TraceEvent[];
  density: DensityBlock[];
}

export function splitSlices(batch: RecordBatch): TimelineBatch {
  const events: TraceEvent[] = [];
  const density: DensityBlock[] = [];
  for (const row of batch) {
    const o = row as Record<string, unknown>;
    if (Number(o.kind) === 0) {
      const raw = o.args ? String(o.args) : "";
      let args: Record<string, unknown> | undefined;
      if (raw) {
        try {
          args = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          args = undefined;
        }
      }
      events.push({
        name: String(o.name ?? ""),
        cat: String(o.cat ?? ""),
        ph: String(o.ph ?? "X"),
        pid: Number(o.pid ?? 0),
        tid: Number(o.tid ?? 0),
        ts: Number(o.ts ?? 0),
        dur: Number(o.dur ?? 0),
        depth: Number(o.depth ?? 0),
        args,
      });
    } else {
      density.push({
        name: String(o.name ?? ""),
        pid: Number(o.pid ?? 0),
        tid: Number(o.tid ?? 0),
        ts: Number(o.ts ?? 0),
        dur: Number(o.dur ?? 0),
        count: Number(o.count ?? 0),
        total: Number(o.total ?? 0),
        depth: Number(o.depth ?? 0),
      });
    }
  }
  return { events, density };
}
