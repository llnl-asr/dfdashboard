import { describe, expect, it } from "vitest";
import type { ProvActivity, ProvEntity, ProvGraphResponse } from "../data/api";
import { entityNode, FLOW, moreNode, typeGraph, typeNode, UNTYPED, view } from "./typegraph";

const ent = (hash: string, type: string, uri = ""): ProvEntity => ({
  hash,
  id: hash,
  type,
  uri,
  store: "",
  pids: [],
});
const act = (
  name: string,
  used: string[],
  generated: string[],
  updated: string[] = [],
): ProvActivity =>
  ({
    aid: name,
    name,
    activity: name,
    pid: 1,
    ts: 0,
    dur: 0,
    used,
    generated,
    invalidated: [],
    updated,
    cat: "",
  }) as ProvActivity;
const graph = (o: Partial<ProvGraphResponse>): ProvGraphResponse =>
  ({ entities: [], activities: [], ...o }) as ProvGraphResponse;

const trace = graph({
  entities: [
    ent("a1", "msa"),
    ent("a2", "msa"),
    ent("b1", "model"),
    ent("b2", "model"),
    ent("c1", "tar"),
  ],
  activities: [
    act("predict", ["a1"], ["b1"]),
    act("predict", ["a2"], ["b2"]),
    act("relax", ["a1"], ["b2"]),
    act("save", ["b1"], ["c1"]),
  ],
  types: [{ name: "msa", role: "input", description: "an alignment" }],
});
const all = () => 100;

describe("typeGraph", () => {
  it("rolls instances up by type, with one edge per related pair of types", () => {
    const v = view(typeGraph(trace), new Set(), all);
    expect(v.nodes.map((n) => [n.id, n.count])).toEqual([
      [typeNode("model"), 2],
      [typeNode("msa"), 2],
      [typeNode("tar"), 1],
    ]);
    expect(v.edges.map((e) => [e.source, e.target, e.links])).toEqual([
      [typeNode("msa"), typeNode("model"), 3],
      [typeNode("model"), typeNode("tar"), 1],
    ]);
  });

  it("says which activities make up an edge, the most frequent first", () => {
    const e = view(typeGraph(trace), new Set(), all).edges[0];
    expect(e.via).toEqual([
      ["predict", 2],
      ["relax", 1],
    ]);
    expect(e.label).toBe("predict, relax");
  });

  it("shortens a long list of activities on the label", () => {
    const d = graph({
      entities: [ent("a", "x"), ent("b", "y")],
      activities: ["p", "q", "r"].map((n) => act(n, ["a"], ["b"])),
    });
    expect(view(typeGraph(d), new Set(), all).edges[0].label).toBe("p, q +1");
  });

  it("keeps entity relations apart from flows", () => {
    const d = graph({
      entities: [ent("a", "x"), ent("b", "y")],
      activities: [act("p", ["a"], ["b"])],
      entity_relations: [{ subject: "b", object: "a", relation: "derived_from" }],
    });
    const edges = view(typeGraph(d), new Set(), all).edges;
    expect(edges.map((e) => [e.kind, e.source])).toEqual([
      [FLOW, typeNode("x")],
      ["derived_from", typeNode("y")],
    ]);
  });

  it("treats an update as both reading and writing", () => {
    const d = graph({
      entities: [ent("a", "x"), ent("u", "y")],
      activities: [act("p", ["a"], [], ["u"])],
    });
    expect(typeGraph(d).links.map((l) => [l.source, l.target])).toEqual([["a", "u"]]);
  });

  it("shows flow inside a type as a loop, but not an instance on itself", () => {
    const d = graph({
      entities: [ent("a", "x"), ent("b", "x")],
      activities: [act("p", ["a"], ["a", "b"])],
    });
    expect(
      view(typeGraph(d), new Set(), all).edges.map((e) => [e.source, e.target, e.links]),
    ).toEqual([[typeNode("x"), typeNode("x"), 1]]);
  });

  it("counts hashes with no entity record instead of inventing a type", () => {
    const g = typeGraph(
      graph({ entities: [ent("a", "x")], activities: [act("p", ["a"], ["ghost"])] }),
    );
    expect(g.links).toEqual([]);
    expect(g.dangling).toBe(1);
  });

  it("gives an entity with no type a place", () => {
    expect(view(typeGraph(graph({ entities: [ent("a", "")] })), new Set(), all).nodes[0].type).toBe(
      UNTYPED,
    );
  });

  it("keeps the role and description of a type", () => {
    expect(typeGraph(trace).types.get("msa")).toMatchObject({
      role: "input",
      description: "an alignment",
    });
  });
});

describe("expanding a type", () => {
  it("turns it into a group of its instances and moves its edges onto them", () => {
    const v = view(typeGraph(trace), new Set(["msa"]), all);
    expect(v.nodes.find((n) => n.id === typeNode("msa"))?.kind).toBe("group");
    expect(v.nodes.filter((n) => n.parent === typeNode("msa")).map((n) => n.id)).toEqual([
      entityNode("a1"),
      entityNode("a2"),
    ]);
    expect(
      v.edges.filter((e) => e.target === typeNode("model")).map((e) => [e.source, e.links]),
    ).toEqual([
      [entityNode("a1"), 2],
      [entityNode("a2"), 1],
    ]);
  });

  it("links instances directly when both sides are expanded", () => {
    const v = view(typeGraph(trace), new Set(["msa", "model"]), all);
    expect(v.edges.map((e) => [e.source, e.target])).toContainEqual([
      entityNode("a2"),
      entityNode("b2"),
    ]);
  });

  it("keeps every link when a type has more instances than it shows", () => {
    const g = typeGraph(trace);
    const v = view(g, new Set(["msa"]), () => 1);
    expect(v.nodes.find((n) => n.id === moreNode("msa"))).toMatchObject({
      kind: "more",
      label: "1 more",
      count: 1,
    });
    const total = (x: typeof v) => x.edges.reduce((s, e) => s + e.links, 0);
    expect(total(v)).toBe(total(view(g, new Set(), all)));
  });
});
