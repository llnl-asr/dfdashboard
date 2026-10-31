// Layout of the Runtime view: provenance activities on a time axis, one lane per process as in the trace timeline, with
// links from the activity that made an entity to each activity that used it.
import type { ProvActivity } from "../data/api";

export interface Span {
  a: ProvActivity;
  lane: number;
  row: number;
}
export interface Lane {
  pid: number;
  rows: number;
  top: number; // row offset of the lane from the first
}
export interface RuntimeLink {
  from: number; // index in spans of the activity that made it
  to: number; // index in spans of an activity that used it
  entity: string;
}
export interface Runtime {
  spans: Span[];
  lanes: Lane[];
  links: RuntimeLink[];
  rows: number;
  t0: number;
  t1: number;
}

/** Each activity on its process's lane, stacked only where they overlap in time. */
export function runtime(activities: ProvActivity[]): Runtime {
  const sorted = activities.slice().sort((x, y) => x.ts - y.ts || x.aid.localeCompare(y.aid));
  const ends = new Map<number, number[]>();
  const spans = sorted.map((a) => {
    if (!ends.has(a.pid)) ends.set(a.pid, []);
    const rowEnds = ends.get(a.pid)!;
    let row = rowEnds.findIndex((end) => end <= a.ts);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = a.ts + a.dur;
    return { a, row, lane: 0 };
  });
  const lanes: Lane[] = [];
  const laneOf = new Map<number, number>();
  let rows = 0;
  for (const s of spans) {
    if (laneOf.has(s.a.pid)) continue;
    const n = ends.get(s.a.pid)!.length;
    laneOf.set(s.a.pid, lanes.length);
    lanes.push({ pid: s.a.pid, rows: n, top: rows });
    rows += n;
  }
  spans.forEach((s) => (s.lane = laneOf.get(s.a.pid)!));

  const maker = new Map<string, number>();
  spans.forEach((s, i) => {
    for (const e of [...s.a.generated, ...(s.a.updated ?? [])]) if (!maker.has(e)) maker.set(e, i);
  });
  const links: RuntimeLink[] = [];
  spans.forEach((s, i) => {
    for (const e of s.a.used) {
      const from = maker.get(e);
      if (from !== undefined && from !== i) links.push({ from, to: i, entity: e });
    }
  });
  const t0 = spans.length ? spans[0].a.ts : 0;
  const t1 = spans.reduce((m, s) => Math.max(m, s.a.ts + s.a.dur), t0);
  return { spans, lanes, links, rows, t0, t1 };
}

/** The links that reach this span, walking `depth` steps in both directions. */
export function linked(r: Runtime, span: number, depth = 1): RuntimeLink[] {
  const out = new Set<RuntimeLink>();
  let up = new Set([span]);
  let down = new Set([span]);
  for (let i = 0; i < depth; i++) {
    const nextUp = new Set<number>();
    const nextDown = new Set<number>();
    for (const l of r.links) {
      if (up.has(l.to)) {
        out.add(l);
        nextUp.add(l.from);
      }
      if (down.has(l.from)) {
        out.add(l);
        nextDown.add(l.to);
      }
    }
    up = nextUp;
    down = nextDown;
  }
  return [...out];
}
