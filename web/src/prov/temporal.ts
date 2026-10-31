// Temporal layout of a provenance graph: time runs top to bottom, one row per node, the way a git graph is drawn.
// Each node owns a vertical track from its row to its last successor's row; a free track is reused, and a node with one
// predecessor continues that predecessor's track when it ends there, so a chain reads as a straight line.
// Edges run down the source's track and bend into the target just above it, so no line crosses a node.
import type { ProvAccess, ProvActivity, ProvEntity, ProvEntityRelation } from "../data/api";

export type NodeKind = "activity" | "entity" | "file";
export interface TNode {
  id: string;
  kind: NodeKind;
  label: string;
  t: number; // when it comes into being, trace microseconds
  type?: string;
  ref: string; // aid, entity hash or file path
}
export interface TEdge {
  source: string;
  target: string;
  kind: "lineage" | "io" | "stored";
}
export interface Placed extends TNode {
  row: number;
  col: number;
}
export interface PlacedEdge extends TEdge {
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
}
export interface Layout {
  nodes: Placed[];
  edges: PlacedEdge[];
  columns: number;
}

export interface Graph {
  activities: ProvActivity[];
  entities: Map<string, ProvEntity>;
  accesses: ProvAccess[];
  relations: ProvEntityRelation[];
}
export interface View {
  activities: boolean;
  io: boolean;
  hiddenTypes: Set<string>;
  picked: Set<string>;
}

const IO_SHOWN = new Set(["read", "write", "delete"]); // open and stat are noise, as in the graph view's default
const LINEAGE_RELATIONS = new Set(["derived_from", "revision_of"]);

export function leaf(path: string): string {
  const p = path.replace(/^file:\/\//, "").replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

export function entityLabel(e: ProvEntity): string {
  return leaf(e.uri) || (/^[0-9a-f]{16}$/.test(e.id) ? e.id.slice(0, 10) + "…" : e.id);
}

const inputsOf = (a: ProvActivity) => a.used;
const outputsOf = (a: ProvActivity) => [...a.generated, ...(a.updated ?? [])];

// Picked entities and everything upstream and downstream of them.
function lineageOf(g: Graph, picked: Set<string>): { acts: Set<string>; ents: Set<string> } {
  const acts = new Set<string>();
  const ents = new Set(picked);
  const walk = (from: (a: ProvActivity) => string[], to: (a: ProvActivity) => string[]) => {
    const seen = new Set(picked);
    const todo = [...seen];
    while (todo.length) {
      const x = todo.pop()!;
      for (const a of g.activities) {
        if (!from(a).includes(x)) continue;
        acts.add(a.aid);
        for (const y of to(a)) {
          if (!seen.has(y)) {
            seen.add(y);
            ents.add(y);
            todo.push(y);
          }
        }
      }
    }
  };
  walk(outputsOf, inputsOf);
  walk(inputsOf, outputsOf);
  return { acts, ents };
}

// The nodes and edges a view asks for, each node dated.
export function select(g: Graph, v: View): { nodes: TNode[]; edges: TEdge[] } {
  const scoped = v.picked.size ? lineageOf(g, v.picked) : null;
  const acts = g.activities.filter((a) => !scoped || scoped.acts.has(a.aid));
  const inScope = (id: string) => !scoped || scoped.ents.has(id);
  const shown = (id: string) => inScope(id) && !v.hiddenTypes.has(g.entities.get(id)?.type ?? "");

  // An entity is born when its first producer ends, or just before its first use if it came from outside.
  const born = new Map<string, number>();
  const earliest = (id: string, t: number) => {
    const cur = born.get(id);
    if (cur === undefined || t < cur) born.set(id, t);
  };
  for (const a of acts) for (const e of outputsOf(a)) earliest(e, a.ts + a.dur);
  for (const a of acts) for (const e of inputsOf(a)) if (!born.has(e) || born.get(e)! > a.ts) earliest(e, a.ts - 1);

  const nodes: TNode[] = [];
  const edges: TEdge[] = [];
  const seen = new Set<string>();
  const edge = (source: string, target: string, kind: TEdge["kind"]) => {
    const k = source + ">" + target;
    if (source !== target && !seen.has(k)) {
      seen.add(k);
      edges.push({ source, target, kind });
    }
  };
  for (const [id, t] of born) {
    if (!shown(id)) continue;
    const e = g.entities.get(id);
    nodes.push({ id: "E:" + id, kind: "entity", label: e ? entityLabel(e) : id.slice(0, 10), t, type: e?.type, ref: id });
  }
  if (v.activities) {
    for (const a of acts) {
      nodes.push({ id: "A:" + a.aid, kind: "activity", label: a.name, t: a.ts, ref: a.aid });
      for (const e of inputsOf(a)) if (shown(e)) edge("E:" + e, "A:" + a.aid, "lineage");
      for (const e of outputsOf(a)) if (shown(e)) edge("A:" + a.aid, "E:" + e, "lineage");
    }
  } else {
    for (const a of acts) {
      for (const x of inputsOf(a)) for (const y of outputsOf(a)) if (shown(x) && shown(y)) edge("E:" + x, "E:" + y, "lineage");
    }
    for (const r of g.relations) {
      if (LINEAGE_RELATIONS.has(r.relation) && shown(r.subject) && shown(r.object)) edge("E:" + r.object, "E:" + r.subject, "lineage");
    }
  }
  if (v.io && v.activities) {
    const ids = new Set(acts.map((a) => a.aid));
    const ts = new Map(acts.map((a) => [a.aid, a.ts]));
    const files = new Map<string, number>();
    const io = g.accesses.filter((x) => ids.has(x.aid) && IO_SHOWN.has(x.op));
    for (const x of io) files.set(x.path, Math.min(files.get(x.path) ?? Infinity, (ts.get(x.aid) ?? 0) - 1));
    for (const [path, t] of files) nodes.push({ id: "F:" + path, kind: "file", label: leaf(path), t, ref: path });
    for (const x of io) {
      if (x.op === "read") edge("F:" + x.path, "A:" + x.aid, "io");
      else edge("A:" + x.aid, "F:" + x.path, "io");
    }
  }
  return { nodes, edges };
}

// Rows by time; columns by tracks. An edge against time (a file read before it was last written) keeps its rows and is
// drawn as such; tracks only ever consider edges that run downward.
export function layout(nodes: TNode[], edges: TEdge[]): Layout {
  const rank = { file: 0, entity: 1, activity: 2 };
  const sorted = [...nodes].sort((a, b) => a.t - b.t || rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
  const row = new Map(sorted.map((n, i) => [n.id, i]));
  const down = edges.filter((e) => row.has(e.source) && row.has(e.target));
  const last = new Map<string, number>();
  const preds = new Map<string, string[]>();
  for (const e of down) {
    const s = row.get(e.source)!;
    const t = row.get(e.target)!;
    if (s < t) {
      last.set(e.source, Math.max(last.get(e.source) ?? s, t));
      preds.set(e.target, [...(preds.get(e.target) ?? []), e.source]);
    }
  }
  const col = new Map<string, number>();
  const busyUntil: number[] = []; // per column: the last row its track is held
  const free = (r: number) => {
    const i = busyUntil.findIndex((u) => u < r);
    return i >= 0 ? i : busyUntil.length;
  };
  sorted.forEach((n, r) => {
    const end = last.get(n.id) ?? r;
    const ps = preds.get(n.id) ?? [];
    const heir = ps.find((p) => last.get(p) === r && busyUntil[col.get(p)!] === r);
    const c = heir !== undefined ? col.get(heir)! : free(r);
    col.set(n.id, c);
    busyUntil[c] = end;
  });
  return {
    nodes: sorted.map((n, i) => ({ ...n, row: i, col: col.get(n.id)! })),
    edges: down.map((e) => ({
      ...e,
      fromRow: row.get(e.source)!,
      toRow: row.get(e.target)!,
      fromCol: col.get(e.source)!,
      toCol: col.get(e.target)!,
    })),
    columns: busyUntil.length,
  };
}

// An SVG path: down the source's track, a rounded bend, into the target from above.
export function edgePath(e: PlacedEdge, x: (col: number) => number, y: (row: number) => number, radius = 7): string {
  const [x0, y0, x1, y1] = [x(e.fromCol), y(e.fromRow), x(e.toCol), y(e.toRow)];
  if (e.fromRow > e.toRow) return `M${x0},${y0} C${x0 + 30},${y0} ${x1 + 30},${y1} ${x1},${y1}`; // against time
  if (x0 === x1) return `M${x0},${y0} L${x1},${y1}`;
  const bend = y1 - (y(1) - y(0)) / 2;
  const dir = x1 > x0 ? 1 : -1;
  return `M${x0},${y0} L${x0},${bend - radius} Q${x0},${bend} ${x0 + dir * radius},${bend} L${x1 - dir * radius},${bend} Q${x1},${bend} ${x1},${bend + radius} L${x1},${y1}`;
}
