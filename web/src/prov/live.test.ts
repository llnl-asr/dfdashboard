import { describe, expect, it } from "vitest";
import type { ProvDelta, ProvGraphResponse } from "../data/api";
import { applyDeltas } from "./live";

const base = (): ProvGraphResponse =>
  ({
    entities: [{ hash: "e1", id: "e1", type: "x", store: "", uri: "", pids: [] }],
    activities: [
      { aid: "a1", name: "p", activity: "p", pid: 1, ts: 0, dur: 1, used: [], generated: ["e1"] },
    ],
    types: [{ name: "x", role: "input", description: "" }],
    entity_relations: [],
    accesses: [],
  }) as unknown as ProvGraphResponse;
const activity = (aid: string, dur: number) =>
  ({
    kind: "activity",
    aid,
    name: "p",
    activity: "p",
    pid: 1,
    ts: 0,
    dur,
    used: [],
    generated: [],
  }) as ProvDelta;

describe("applyDeltas", () => {
  it("adds each kind of record without its kind tag", () => {
    const g = applyDeltas(base(), [
      activity("a2", 2),
      { kind: "entity", hash: "e2", id: "e2", type: "y", store: "", uri: "", pids: [] },
      { kind: "type", name: "y", role: "output", description: "" },
      { kind: "relation", subject: "e2", object: "e1", relation: "derived_from" },
    ] as ProvDelta[]);
    expect(g.activities.map((a) => a.aid)).toEqual(["a1", "a2"]);
    expect(g.entities[1]).not.toHaveProperty("kind");
    expect(g.types?.map((t) => t.name)).toEqual(["x", "y"]);
    expect(g.entity_relations?.[0].relation).toBe("derived_from");
  });

  it("replaces a record seen again, as an activity that gained its end", () => {
    expect(applyDeltas(base(), [activity("a1", 9)]).activities).toMatchObject([
      { aid: "a1", dur: 9 },
    ]);
  });

  it("leaves the graph on screen untouched", () => {
    const g = base();
    applyDeltas(g, [activity("a2", 2)]);
    expect(g.activities).toHaveLength(1);
  });
});
