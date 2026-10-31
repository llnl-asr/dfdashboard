// Entity types and how they relate, derived from the instances a trace saw, for the Types view.
//
// Links are the instance-level facts: an activity that used a and generated b links a to b, and an
// entity relation links its subject to its object. view() draws them at the level asked for: a
// collapsed type stands for all its instances, an expanded one shows them, up to a limit per type.
import type { ProvEntity, ProvGraphResponse } from "../data/api";

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
