// Entity types and how they relate, derived from the instances a trace saw, for the Types view.
//
// Links are the instance-level facts: an activity that used a and generated b links a to b, and an
// entity relation links its subject to its object. view() draws them at the level asked for: a
// collapsed type stands for all its instances, an expanded one shows them, up to a limit per type.
import type { ProvActivity, ProvEntity, ProvGraphResponse } from "../data/api";

// Categorical palette readable on both the dark and light themes.
export const PALETTE = [
  "#4e9fd6",
  "#e6a13c",
  "#5fb87a",
  "#d9675f",
  "#a07bd1",
  "#3fb5a8",
  "#d4c04a",
  "#e07fb3",
  "#7f9cc2",
  "#b8865a",
  "#8fbf4d",
  "#c26d9e",
  "#5c8f8a",
  "#d98f4e",
  "#6f7fd6",
  "#9aa55a",
];

export const FLOW = "flow";
export const UNTYPED = "(untyped)";
const REST_LABEL_MAX = 2;

export interface TypeInfo {
  name: string;
  role: string;
  description: string;
  color: string;
  instances: ProvEntity[];
}

/** One instance-level fact: `kind` is FLOW or a relation name, `via` the activity or relation. */
export interface Link {
  source: string;
  target: string;
  kind: string;
  via: string;
}

export interface TypeGraph {
  types: Map<string, TypeInfo>;
  type: Map<string, string>; // entity hash -> type
  links: Link[];
  dangling: number; // hashes used by an activity or relation with no entity record
}

export type VNodeKind = "type" | "group" | "entity" | "more";

export interface VNode {
  id: string;
  kind: VNodeKind;
  label: string;
  type: string;
  parent?: string;
  count: number;
  entity?: ProvEntity;
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  label: string;
  links: number;
  via: [string, number][]; // most frequent first
}

export interface TypeView {
  nodes: VNode[];
  edges: VEdge[];
}

export const typeNode = (t: string) => "T:" + t;
export const entityNode = (hash: string) => "E:" + hash;
export const moreNode = (t: string) => "M:" + t;

export function entityLabel(e: { id: string; uri: string }): string {
  if (!e.uri) return e.id.slice(0, 8);
  return e.uri.split("/").filter(Boolean).pop() ?? e.uri;
}

export function typeGraph(d: ProvGraphResponse): TypeGraph {
  const info = new Map((d.types ?? []).map((t) => [t.name, t] as const));
  const byType = new Map<string, ProvEntity[]>();
  const type = new Map<string, string>();
  for (const e of d.entities) {
    const t = e.type || UNTYPED;
    type.set(e.hash, t);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(e);
  }
  const types = new Map<string, TypeInfo>();
  [...byType.keys()].sort().forEach((name, i) => {
    types.set(name, {
      name,
      role: info.get(name)?.role ?? "",
      description: info.get(name)?.description ?? "",
      color: PALETTE[i % PALETTE.length],
      instances: byType
        .get(name)!
        .slice()
        .sort((a, b) => entityLabel(a).localeCompare(entityLabel(b))),
    });
  });

  const seen = new Set<string>();
  const missing = new Set<string>();
  const links: Link[] = [];
  const known = (hash: string) => {
    if (!type.has(hash)) missing.add(hash);
    return type.has(hash);
  };
  const add = (source: string, target: string, kind: string, via: string) => {
    if (source === target || !known(source) || !known(target)) return;
    const key = [source, target, kind, via].join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target, kind, via });
  };
  for (const a of d.activities) {
    const updated = a.updated ?? [];
    const inputs = [...a.used, ...updated];
    const outputs = [...a.generated, ...updated];
    for (const i of inputs) for (const o of outputs) add(i, o, FLOW, a.name);
  }
  for (const r of d.entity_relations ?? []) add(r.subject, r.object, r.relation, r.relation);
  return { types, type, links, dangling: missing.size };
}

export interface Behavior {
  name: string;
  count: number;
  always: { uses: string[]; makes: string[] };
  sometimes: { uses: [string, number][]; makes: [string, number][] };
}

/** What each activity does with entity types, across every time it ran: a type in `always` was involved every time. */
export function behaviors(g: TypeGraph, activities: ProvActivity[]): Behavior[] {
  const groups = new Map<string, ProvActivity[]>();
  for (const a of activities) {
    if (!groups.has(a.name)) groups.set(a.name, []);
    groups.get(a.name)!.push(a);
  }
  const split = (runs: ProvActivity[], hashes: (a: ProvActivity) => string[]) => {
    const seen = new Map<string, number>();
    for (const a of runs) {
      const types = new Set(hashes(a).flatMap((h) => g.type.get(h) ?? []));
      for (const t of types) seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    const rows = [...seen.entries()].sort((x, y) => x[0].localeCompare(y[0]));
    return {
      always: rows.filter(([, n]) => n === runs.length).map(([t]) => t),
      sometimes: rows.filter(([, n]) => n < runs.length),
    };
  };
  return [...groups.entries()]
    .map(([name, runs]) => {
      const uses = split(runs, (a) => a.used);
      const makes = split(runs, (a) => [...a.generated, ...(a.updated ?? [])]);
      return {
        name,
        count: runs.length,
        always: { uses: uses.always, makes: makes.always },
        sometimes: { uses: uses.sometimes, makes: makes.sometimes },
      };
    })
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
}

export type Tally = [string, number][];

export interface Overview {
  processes: number;
  activityKinds: number;
  roots: number; // entities nothing in the trace made
  leaves: number; // entities nothing in the trace used
  depth: number; // activities on the longest chain from a root
  byType: Tally;
  byStore: Tally;
  byRole: Tally;
  activityRuns: Tally;
  activityTime: Tally; // microseconds
  reuse: Tally; // how many activities used each entity
  created: number[]; // entities made in each slice of the run
  span: number; // microseconds the run covers
}

const REUSE_BINS: [string, number, number][] = [
  ["0", 0, 0],
  ["1", 1, 1],
  ["2", 2, 2],
  ["3-5", 3, 5],
  ["6-20", 6, 20],
  ["21+", 21, Infinity],
];
export const CREATED_BINS = 24;

const tally = (items: string[]): Tally => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/** Longest chain of activities, each using what an earlier one made. */
function chainDepth(activities: ProvActivity[]): number {
  const sorted = activities.slice().sort((a, b) => a.ts - b.ts);
  const reached = new Map<string, number>(); // entity -> activities on the longest chain that made it
  let most = 0;
  for (const a of sorted) {
    const depth = Math.max(0, ...a.used.map((e) => reached.get(e) ?? 0)) + 1;
    most = Math.max(most, depth);
    for (const e of [...a.generated, ...(a.updated ?? [])])
      reached.set(e, Math.max(reached.get(e) ?? 0, depth));
  }
  return most;
}

/** The numbers that describe a run's provenance, independent of any one instance. */
export function overview(g: TypeGraph, d: ProvGraphResponse): Overview {
  const made = new Map<string, number>();
  const uses = new Map<string, number>();
  const time = new Map<string, number>();
  const a = d.activities;
  const t0 = a.reduce((m, x) => Math.min(m, x.ts), a.length ? Infinity : 0);
  const t1 = a.reduce((m, x) => Math.max(m, x.ts + x.dur), 0);
  const span = t1 - t0;
  for (const x of a) {
    time.set(x.name, (time.get(x.name) ?? 0) + x.dur);
    for (const e of x.generated) if (!made.has(e)) made.set(e, x.ts + x.dur);
    for (const e of new Set(x.used)) uses.set(e, (uses.get(e) ?? 0) + 1);
  }
  const created = new Array<number>(CREATED_BINS).fill(0);
  for (const t of made.values())
    created[
      Math.min(Math.floor(((t - t0) / Math.max(span, 1)) * CREATED_BINS), CREATED_BINS - 1)
    ] += 1;
  const counts = d.entities.map((e) => uses.get(e.hash) ?? 0);
  return {
    processes: new Set(a.map((x) => x.pid)).size,
    activityKinds: time.size,
    roots: d.entities.filter((e) => !made.has(e.hash)).length,
    leaves: counts.filter((n) => n === 0).length,
    depth: chainDepth(a),
    byType: [...g.types.values()]
      .map((t): [string, number] => [t.name, t.instances.length])
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
    byStore: tally(d.entities.map((e) => e.store || "unknown")),
    byRole: tally(d.entities.map((e) => g.types.get(e.type || UNTYPED)?.role || "undescribed")),
    activityRuns: tally(a.map((x) => x.name)),
    activityTime: [...time.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
    reuse: REUSE_BINS.map(([label, lo, hi]) => [
      label,
      counts.filter((n) => n >= lo && n <= hi).length,
    ]),
    created,
    span,
  };
}

function edgeLabel(kind: string, via: [string, number][]): string {
  if (kind !== FLOW) return kind;
  const names = via.slice(0, REST_LABEL_MAX).map(([name]) => name);
  const rest = via.length - names.length;
  return names.join(", ") + (rest > 0 ? ` +${rest}` : "");
}

/** The graph at this level of detail. `limits` is how many instances an expanded type shows. */
export function view(g: TypeGraph, expanded: Set<string>, limits: (t: string) => number): TypeView {
  const nodes: VNode[] = [];
  const where = new Map<string, string>();
  for (const t of g.types.values()) {
    const n = t.instances.length;
    if (!expanded.has(t.name)) {
      nodes.push({ id: typeNode(t.name), kind: "type", label: t.name, type: t.name, count: n });
      t.instances.forEach((e) => where.set(e.hash, typeNode(t.name)));
      continue;
    }
    nodes.push({ id: typeNode(t.name), kind: "group", label: t.name, type: t.name, count: n });
    const shown = Math.min(n, limits(t.name));
    t.instances.forEach((e, i) => {
      if (i < shown) {
        const id = entityNode(e.hash);
        nodes.push({
          id,
          kind: "entity",
          label: entityLabel(e),
          type: t.name,
          parent: typeNode(t.name),
          count: 1,
          entity: e,
        });
        where.set(e.hash, id);
      } else {
        where.set(e.hash, moreNode(t.name));
      }
    });
    if (shown < n) {
      nodes.push({
        id: moreNode(t.name),
        kind: "more",
        label: `${n - shown} more`,
        type: t.name,
        parent: typeNode(t.name),
        count: n - shown,
      });
    }
  }

  const grouped = new Map<
    string,
    { source: string; target: string; kind: string; links: number; via: Map<string, number> }
  >();
  for (const l of g.links) {
    const source = where.get(l.source)!;
    const target = where.get(l.target)!;
    const key = [source, target, l.kind].join("\0");
    let e = grouped.get(key);
    if (!e) grouped.set(key, (e = { source, target, kind: l.kind, links: 0, via: new Map() }));
    e.links += 1;
    e.via.set(l.via, (e.via.get(l.via) ?? 0) + 1);
  }
  const edges = [...grouped.entries()].map(([id, e]) => {
    const via = [...e.via.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      links: e.links,
      via,
      label: edgeLabel(e.kind, via),
    };
  });
  return { nodes, edges };
}
