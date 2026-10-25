import { createSignal } from "solid-js";

import { fetchRuns, openRunsStream, type RunInfo } from "../data/api";
import type { Timeline } from "../timeline/timeline";
import type { ViewState } from "./viewstate";

// A tree can hold hundreds of runs, so the bar pins only the ones worth
// clicking and the rest move behind a filterable list.
const PIN_FINISHED = 2;
const LIST_MAX = 300;

export interface RunsFrame {
  seq: number;
  runs: RunInfo[];
  watch?: "poll" | "events";
}

/** The run list, the scope and the live stream that keeps both fresh.
 *
 * One owner for `?run=`: the signal starts from the URL, every change mirrors
 * back to it, and nothing reads the URL again.
 */
export function useRuns(deps: {
  state: ViewState;
  timeline: () => Timeline | undefined;
  baseTs: () => number;
  onNewFrame: () => void;
  onFirstTrace: () => void;
}) {
  const { state } = deps;
  const [list, setList] = createSignal<RunInfo[]>([]);
  const [feed, setFeed] = createSignal<"off" | "live">("off");
  const [watchMode, setWatchMode] = createSignal<"poll" | "events">("poll");
  const [scope, setScope] = createSignal(new URLSearchParams(location.search).get("run") || "");
  const [picker, setPicker] = createSignal(false);
  const [filter, setFilter] = createSignal("");

  const pinned = () => {
    const all = list();
    const live = all.filter((r) => r.state === "live" || r.state === "stalled");
    const done = all.filter((r) => r.state !== "live" && r.state !== "stalled");
    const keep = new Set([...live, ...done.slice(-PIN_FINISHED)].map((r) => r.id));
    if (scope()) keep.add(scope());
    return all.filter((r) => keep.has(r.id));
  };
  const hidden = () => list().length - pinned().length;
  const listed = () => {
    const q = filter().trim().toLowerCase();
    const hits = q
      ? list().filter((r) => `${r.id} ${r.format} ${r.state} ${r.dir}`.toLowerCase().includes(q))
      : list();
    return hits.slice(0, LIST_MAX);
  };

  /** True when the frame moved the tree; a same-seq frame is a repaint only. */
  function apply(frame: RunsFrame): boolean {
    setList(frame.runs);
    if (frame.watch) setWatchMode(frame.watch);
    pushToTimeline(frame.runs);
    if (frame.seq === state.runsSeq) return false;
    state.runsSeq = frame.seq;
    return true;
  }

  function pushToTimeline(runs: RunInfo[]): void {
    const base = deps.baseTs();
    deps.timeline()?.setRuns(
      runs.map((r) => ({
        id: r.id,
        state: r.state,
        begin: Math.max(0, r.first_ts - base),
        end: Math.max(0, r.last_ts - base),
      })),
    );
  }

  // A scoped run can vanish when the tree is wiped or a run directory is
  // renamed; drop it so the view falls back to all runs instead of asking for
  // a run that no longer exists.
  function dropScope(): void {
    setScope("");
    const p = new URLSearchParams(location.search);
    if (!p.has("run")) return;
    p.delete("run");
    const q = p.toString();
    history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}`);
  }

  function select(id: string): void {
    const p = new URLSearchParams(location.search);
    if (id) p.set("run", id);
    else p.delete("run");
    setScope(id);
    location.search = p.toString();
  }

  /** The first frame settles a scope that outlived its run, then the stream
   * runs until the view is disposed. */
  async function attach(): Promise<void> {
    const first = await fetchRuns(scope()).catch(() => null);
    if (first) {
      apply(first);
      if (scope() && !first.runs.some((r) => r.id === scope())) dropScope();
    }
    state.stopRuns = openRunsStream((f) => {
      setFeed("live");
      const arrived = list().length === 0 && f.runs.length > 0;
      if (apply(f) && !arrived) deps.onNewFrame();
      if (arrived) deps.onFirstTrace();
    });
  }

  return {
    list,
    feed,
    watchMode,
    scope,
    picker,
    setPicker,
    filter,
    setFilter,
    pinned,
    hidden,
    listed,
    apply,
    dropScope,
    select,
    attach,
  };
}
