import type { FlameNode } from "../data/types";
import type { Flamegraph } from "../flame/flamegraph";
import type { Timeline } from "../timeline/timeline";

/** One abort controller per in-flight request, keyed by what it loads.
 *
 * `start` supersedes the previous request for the same key, so a caller never
 * writes the `x?.abort(); x = new AbortController()` dance by hand.
 */
export class Inflight {
  private byKey = new Map<string, AbortController>();

  start(key: string): AbortController {
    this.byKey.get(key)?.abort();
    const ac = new AbortController();
    this.byKey.set(key, ac);
    return ac;
  }

  abort(key: string): void {
    this.byKey.get(key)?.abort();
    this.byKey.delete(key);
  }

  isCurrent(key: string, ac: AbortController): boolean {
    return this.byKey.get(key) === ac;
  }

  abortAll(): void {
    for (const ac of this.byKey.values()) ac.abort();
    this.byKey.clear();
  }
}

/** The mutable handles one mounted App owns: rendering engines, request
 * controllers, timers and the load bookkeeping that is not reactive.
 *
 * They live in one object so `dispose()` can end every request and timer at
 * once. Nothing here is a signal: a signal drives the UI, this drives the
 * machinery behind it.
 */
export class ViewState {
  readonly inflight = new Inflight();

  // Rendering engines, created on mount.
  timeline?: Timeline;
  flame?: Flamegraph;
  bottomFlame?: Flamegraph;
  inspCallersFg?: Flamegraph;
  inspCalleesFg?: Flamegraph;

  // Real operation name -> category from /viz/layers; empty until it loads.
  layerMap: Record<string, string> = {};

  // Load bookkeeping.
  totalSpan = 1;
  loaded = { begin: 0, end: 0, summary: -1 };
  maxDurSeen = 0;
  autoFitted = false;
  runsSeq = -1;
  stopRuns: (() => void) | null = null;
  recovering = false;
  refreshing = false;
  refreshedAt = 0;
  flameLoadedQuery: string | null = null;
  anFlameKey: string | null = null;
  inspTreeQuery: string | null = null;
  inspTreePromise: Promise<FlameNode | null> | null = null;

  // Timers.
  dashSaveTimer?: number;
  topEvTimer?: number;

  dispose(): void {
    this.inflight.abortAll();
    this.stopRuns?.();
    this.stopRuns = null;
    if (this.dashSaveTimer !== undefined) clearTimeout(this.dashSaveTimer);
    if (this.topEvTimer !== undefined) clearTimeout(this.topEvTimer);
  }
}
