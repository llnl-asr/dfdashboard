import { describe, expect, it } from "vitest";
import type { ProvActivity, ProvEntity } from "../data/api";
import {
  edgePath,
  type Graph,
  layout,
  select,
  type TEdge,
  type TNode,
  type View,
} from "./temporal";

const ent = (id: string, type = "t", uri = ""): ProvEntity => ({
  hash: id,
  id,
  type,
  uri,
  store: "",
  pids: [],
});
const act = (
  aid: string,
  ts: number,
  dur: number,
  used: string[],
  generated: string[],
): ProvActivity => ({
  aid,
  name: aid,
  activity: aid,
  pid: 1,
  ts,
  dur,
  used,
  generated,
  invalidated: [],
  updated: [],
  cat: "moirai",
});
const graph = (activities: ProvActivity[], ids: string[]): Graph => ({
  activities,
  entities: new Map(ids.map((i) => [i, ent(i, i.startsWith("x") ? "other" : "t")])),
  accesses: [],
  relations: [],
});
const view = (o: Partial<View> = {}): View => ({
  activities: true,
  io: true,
  hiddenTypes: new Set(),
  picked: new Set(),
  ...o,
});
const n = (id: string, t: number): TNode => ({ id, kind: "activity", label: id, t, ref: id });
const e = (source: string, target: string): TEdge => ({ source, target, kind: "lineage" });

describe("layout", () => {
  it("orders rows by time", () => {
    expect(layout([n("b", 2), n("a", 1)], []).nodes.map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("draws a chain as one straight track", () => {
    const l = layout([n("a", 1), n("b", 2), n("c", 3)], [e("a", "b"), e("b", "c")]);
    expect(l.nodes.map((x) => x.col)).toEqual([0, 0, 0]);
    expect(l.columns).toBe(1);
  });
  it("holds a track until the last successor and reuses it after", () => {
    const l = layout([n("a", 1), n("b", 2), n("c", 3), n("d", 4)], [e("a", "c")]);
    const col = Object.fromEntries(l.nodes.map((x) => [x.id, x.col]));
    expect(col.b).not.toBe(col.a); // a's track is held across b's row
    expect(col.d).toBe(0);
  });
  it("never puts a node on a track held by another", () => {
    const nodes = [n("a", 1), n("b", 2), n("c", 3), n("d", 4), n("e", 5)];
    const l = layout(nodes, [e("a", "d"), e("b", "e"), e("a", "e")]);
    for (const ed of l.edges) {
      for (const x of l.nodes) {
        if (x.col === ed.fromCol && x.row > ed.fromRow && x.row < ed.toRow)
          expect(x.id).toBe("none");
      }
    }
  });
  it("survives a cycle", () => {
    const l = layout([n("a", 1), n("b", 2)], [e("a", "b"), e("b", "a")]);
    expect(l.nodes).toHaveLength(2);
    expect(
      l.edges
        .map((x) =>
          edgePath(
            x,
            (c) => c * 10,
            (r) => r * 10,
          ),
        )
        .every((p) => p.startsWith("M")),
    ).toBe(true);
  });
});

describe("select", () => {
  const g = graph(
    [
      act("make", 10, 5, [], ["e1"]),
      act("fit", 20, 5, ["e1"], ["e2"]),
      act("other", 30, 5, ["x1"], ["x2"]),
    ],
    ["e1", "e2", "x1", "x2"],
  );
  const ids = (o: Partial<View>) =>
    select(g, view(o))
      .nodes.map((x) => x.id)
      .sort();

  it("dates an entity by its producer, and an input just before its first use", () => {
    const t = Object.fromEntries(select(g, view()).nodes.map((x) => [x.id, x.t]));
    expect(t["E:e1"]).toBe(15);
    expect(t["E:x1"]).toBe(29);
  });
  it("picking an entity keeps its whole lineage and nothing else", () => {
    expect(ids({ picked: new Set(["e2"]) })).toEqual(["A:fit", "A:make", "E:e1", "E:e2"]);
  });
  it("hiding a type hides its entities", () => {
    expect(ids({ hiddenTypes: new Set(["other"]) })).not.toContain("E:x1");
  });
  it("hiding activities links entities directly", () => {
    const s = select(g, view({ activities: false }));
    expect(s.nodes.some((x) => x.kind === "activity")).toBe(false);
    expect(s.edges).toContainEqual({ source: "E:e1", target: "E:e2", kind: "lineage" });
  });
  it("shows reads and writes as files, and leaves open and stat out", () => {
    const io: Graph = {
      ...g,
      accesses: [
        { aid: "fit", fhash: "f", path: "/d/a", op: "read", calls: 1, bytes: 1 },
        { aid: "fit", fhash: "g", path: "/d/b", op: "write", calls: 1, bytes: 1 },
        { aid: "fit", fhash: "h", path: "/d/c", op: "meta", calls: 1, bytes: 0 },
      ],
    };
    const s = select(io, view());
    expect(
      s.nodes
        .filter((x) => x.kind === "file")
        .map((x) => x.label)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(s.edges).toContainEqual({ source: "F:/d/a", target: "A:fit", kind: "io" });
    expect(s.edges).toContainEqual({ source: "A:fit", target: "F:/d/b", kind: "io" });
    expect(select(io, view({ io: false })).nodes.some((x) => x.kind === "file")).toBe(false);
  });
});
