import { describe, expect, it } from "vitest";
import type { ProvActivity } from "../data/api";
import { linked, runtime } from "./runtime";

const act = (
  aid: string,
  pid: number,
  ts: number,
  dur: number,
  used: string[] = [],
  generated: string[] = [],
  updated: string[] = [],
): ProvActivity =>
  ({
    aid,
    name: aid,
    activity: aid,
    pid,
    ts,
    dur,
    used,
    generated,
    updated,
    invalidated: [],
    cat: "",
  }) as ProvActivity;

describe("runtime", () => {
  it("gives each process a lane, in order of first activity", () => {
    const r = runtime([act("b", 2, 5, 1), act("a", 1, 0, 1)]);
    expect(r.lanes.map((l) => l.pid)).toEqual([1, 2]);
    expect(r.spans.map((s) => [s.a.aid, s.lane])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect([r.t0, r.t1]).toEqual([0, 6]);
  });

  it("stacks only activities that overlap", () => {
    const r = runtime([
      act("a", 1, 0, 10),
      act("b", 1, 2, 3),
      act("c", 1, 10, 1),
      act("d", 1, 3, 1),
    ]);
    expect(Object.fromEntries(r.spans.map((s) => [s.a.aid, s.row]))).toEqual({
      a: 0,
      b: 1,
      d: 2,
      c: 0,
    });
    expect(r.lanes[0].rows).toBe(3);
  });

  it("offsets each lane by the rows above it", () => {
    const r = runtime([act("a", 1, 0, 10), act("b", 1, 2, 1), act("c", 2, 3, 1)]);
    expect(r.lanes.map((l) => l.top)).toEqual([0, 2]);
    expect(r.rows).toBe(3);
  });

  it("links the maker of an entity to each activity that used it, across processes", () => {
    const r = runtime([
      act("make", 1, 0, 1, [], ["e"]),
      act("use1", 2, 2, 1, ["e"]),
      act("use2", 3, 3, 1, ["e"]),
    ]);
    expect(r.links.map((l) => [r.spans[l.from].a.aid, r.spans[l.to].a.aid, l.entity])).toEqual([
      ["make", "use1", "e"],
      ["make", "use2", "e"],
    ]);
  });

  it("links from an update, and not from an activity to itself", () => {
    const r = runtime([act("u", 1, 0, 1, ["e"], [], ["e"]), act("next", 1, 2, 1, ["e"])]);
    expect(r.links.map((l) => r.spans[l.to].a.aid)).toEqual(["next"]);
  });

  it("does not link an entity nobody in the trace made", () => {
    expect(runtime([act("a", 1, 0, 1, ["input"])]).links).toEqual([]);
  });

  it("handles an empty trace", () => {
    expect(runtime([])).toMatchObject({ spans: [], lanes: [], links: [], rows: 0, t0: 0, t1: 0 });
  });
});

describe("linked", () => {
  const r = runtime([
    act("a", 1, 0, 1, [], ["x"]),
    act("b", 1, 2, 1, ["x"], ["y"]),
    act("c", 1, 4, 1, ["y"], ["z"]),
    act("d", 1, 6, 1, ["z"]),
  ]);
  it("takes one step each way by default", () => {
    expect(
      linked(r, 1)
        .map((l) => l.entity)
        .sort(),
    ).toEqual(["x", "y"]);
  });
  it("follows further when asked", () => {
    expect(
      linked(r, 0, 3)
        .map((l) => l.entity)
        .sort(),
    ).toEqual(["x", "y", "z"]);
  });
});
