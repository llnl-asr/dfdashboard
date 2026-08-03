import type { DensityBlock, ProcTreeNode, TraceEvent } from "../data/types";
import { colorFor, contrastText, sliceKey } from "./color";
import {
  formatBytesCompact,
  formatBytesPerSec,
  formatRate,
  formatTick,
  formatTime,
  niceStep,
} from "./format";
import { buildTimeAxis, type TimeAxis } from "./timeaxis";
import { vizTheme, type ThemeMode, type VizTheme } from "./theme";

export interface Viewport {
  begin: number;
  end: number;
}

interface Slice {
  ev: TraceEvent;
  ts: number;
  dur: number;
  laneIdx: number;
  depth: number;
  sdepth: number; // server-computed containment depth, or -1 (fall back to stacking)
  count: number; // >1 for aggregated density blocks
  total: number; // summed busy time (== dur for individual events)
  density: boolean;
}

interface Lane {
  key: string;
  pid: string;
  tid: string;
  rows: number;
  y: number; // top offset within content (below ruler), in css px
  kind: "host" | "proc" | "thread";
  label: string;
  indent: number; // gutter indent, px
  collapsible: boolean;
  collapseKey: string; // key toggled in `collapsed`; "" for leaf threads
  flatten: boolean; // a summary row (host / collapsed proc): render load, not bars
  host: string;
  processFirst: boolean;
  soleThread: boolean;
  depth: number; // fork-hierarchy depth (0 = root)
}

export interface Gap {
  laneIdx: number;
  label: string;
  t0: number;
  t1: number;
  dur: number;
}

export interface TimelineCallbacks {
  // Fired (debounced) when the target time window changes; the app turns this
  // into a /viz/events query.
  onRangeChange?: (begin: number, end: number) => void;
  // Fired every animated frame while the live viewport moves; lets overlays
  // (e.g. the counter panel) track pan/zoom smoothly, not just on settle.
  onFrame?: () => void;
  // Click on a host row's node-strip chip; the app cycles the strip counter.
  onNodeStripClick?: () => void;
  // Cursor over a host row's strip: readout text with the raw values, or null.
  onNodeStripHover?: (text: string | null, clientX: number, clientY: number) => void;
  onHover?: (ev: TraceEvent | null, clientX: number, clientY: number) => void;
  // Cursor over a gutter column header (track/i/o util/ops/i/o ops/bytes).
  onHeaderHover?: (key: string | null, clientX: number, clientY: number) => void;
  onSelect?: (ev: TraceEvent | null) => void;
  // Fired when the user finishes dragging a time-range selection (for stats).
  onSelectRange?: (t0: number, t1: number) => void;
  onSelectRangeClear?: () => void;
}

export const GUTTER = 348;
const COL_UTIL = 128; // left edge of the I/O UTIL bar column
const COL_UTIL_W = 44;
const COL_OPS = 282; // right edge of the OPS (ops/s) column
const COL_BYTES = GUTTER - 12; // right edge of the BYTES column
const RULER_H = 28;
const ROW_H = 18;
const LANE_GAP = 6;
const HOST_GAP = 12; // vertical separation between host groups
const TWIST_W = 14; // twisty hit-area / indent step per tree level
const MIN_SPAN = 1; // microseconds
const LANE_RAMP_STEPS = 16;

function hexRgb(h: string): [number, number, number] {
  const s = h.startsWith("#") ? h.slice(1) : h;
  const n = parseInt(s.length === 3 ? s.replace(/./g, "$&$&") : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const EASE = 0.22;
const RANGE_DEBOUNCE_MS = 130;
// Zoom aggressiveness: exp(delta * SENSITIVITY). Wheel deltas are coalesced per
// animation frame and each frame applies at most ZOOM_MAX_STEP px of delta, so a
// momentum/high-resolution burst glides in smoothly instead of leaping.
const ZOOM_SENSITIVITY = 0.0025;
const ZOOM_MAX_STEP = 90;
const MINI_COLS = 600; // activity buckets across the whole trace
const NAV_KEYS = new Set(["w", "a", "s", "d", "arrowleft", "arrowright", "arrowup", "arrowdown"]);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(v: unknown, def = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

export class Timeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: TimelineCallbacks;

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private totalSpan = 1;
  private live: Viewport = { begin: 0, end: 1 };
  private target: Viewport = { begin: 0, end: 1 };

  private slices: Slice[] = [];
  private slicesByKey = new Map<string, Slice[]>();
  private lanes: Lane[] = [];
  // Slice coloring: by category (default), or a sequential ramp over a derived
  // metric (transfer size from args.ret, or latency from dur).
  private colorMode: "category" | "size" | "latency" = "category";
  private durDomain: [number, number] = [0, 1]; // log-space [min,max]
  private sizeDomain: [number, number] = [0, 1];
  private contentH = 0;
  private scrollY = 0;
  private processLabels = new Map<string, string>();

  // Every (pid/tid) lane ever seen, so a track stays visible (empty) when the
  // current window has no events for it, instead of vanishing on zoom.
  private laneRegistry = new Set<string>();

  // Fork hierarchy (by pid): DFS order, depth, parent, and spawn timestamp.
  private procOrder = new Map<number, number>();
  private procDepth = new Map<number, number>();
  private procParent = new Map<number, number>();
  private procSpawn = new Map<number, number>(); // parent's clone timestamp
  private procFirst = new Map<number, number>(); // child's first-event timestamp
  private hasRanks = false; // PR metadata present: order by rank, not host

  private mini?: HTMLCanvasElement;
  private miniCtx?: CanvasRenderingContext2D;
  private miniW = 0;
  private miniH = 0;
  private miniActivity: number[] = [];
  private miniActivityMax = 1;
  // Whole-trace per-lane activity for the minimap heatmap (keyed pid/tid).
  private overviewLanes = new Map<string, Float64Array>();
  private overviewMax = 1;
  private ovOpsByPid = new Map<number, number>(); // total events per pid
  private ioBusyByPid = new Map<number, number>(); // I/O busy us per pid
  private miniDragging = false;
  private miniAnchorT = 0;
  private miniAnchorX = 0;
  private miniMoved = false;
  private miniSel: { t0: number; t1: number } | null = null;

  private searchTerm = "";
  private searchMatches: Slice[] = [];
  private searchMatchSet = new Set<Slice>();
  private searchIdx = -1;

  private counterCanvas?: HTMLCanvasElement;
  private counterCtx?: CanvasRenderingContext2D;
  private counterW = 0;
  private counterH = 0;
  private counters?: { begin: number; bucketUs: number; read: number[]; write: number[] };
  private counterPeak = 1; // bytes/sec

  // Per-lane counter heat: one ph="C" counter split by pid, drawn as a
  // background tint behind each process lane's slices (docked from the overlay).
  private laneCounter: {
    begin: number;
    bucketUs: number;
    buckets: number;
    byPid: Map<string, number[]>;
    max: number;
    ramp: string[];
  } | null = null;

  // Per-node system telemetry, stacked as a percent-of-row strip on the host
  // rows (which carry no slices of their own).
  private nodeCounters: {
    begin: number;
    bucketUs: number;
    buckets: number;
    byHost: Map<string, { key: string; values: number[]; counts?: number[]; color: string }[]>;
    scale: number; // raw value -> percent of row (1 for _pct, 100/peak otherwise)
  } | null = null;
  // Host rows grow by one row while a strip is shown so it is actually legible.
  private nodeStripBoost = 0;
  // In-context control: a chip on each host row naming the strip counter;
  // clicking it cycles the selection (handled by the app via onNodeStripClick).
  private nodeStripLabel: string | null = null;
  private nodeStripBadges: { x: number; y: number; w: number; h: number }[] = [];
  private nodeStripHoverAt: { host: string; i: number } | null = null;

  private gaps: Gap[] = [];
  private showGaps = false;
  private hoveredGap: Gap | null = null;
  private selectedGap: Gap | null = null;

  // Timelapse axis: between-run idle spans (real us) compressed to a fixed
  // display width so active periods sit together. Viewport math runs in the
  // compressed (display) space; events carry real ts mapped through the knots.
  private runGaps: { begin: number; end: number }[] = [];
  private timelapse = false;
  private realTotal = 1;
  private axis: TimeAxis = buildTimeAxis([], 1, false);

  private selected: TraceEvent | null = null;
  private hovered: Slice | null = null;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = false;
  private gutterDown: { x: number; y: number } | null = null;
  private mouseX = GUTTER;
  private cursorInside = false;
  private keys = new Set<string>();
  private pendingZoom = 0;
  private zoomFocusX = GUTTER;
  private selecting = false;
  private selAnchorT = 0;
  private selection: { t0: number; t1: number } | null = null;

  private th: VizTheme = vizTheme("dark");
  private hostByPid = new Map<number, string>();
  private hostPids = new Map<string, number[]>();
  private bytesByPid = new Map<number, number>();
  private collapsed = new Set<string>();
  private raf = 0;
  private frameScheduled = false;
  private _dirty = true;
  private rangeTimer = 0;
  private ro?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, cb: TimelineCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("mouseleave", this.onMouseLeave);
    canvas.addEventListener("dblclick", this.onDblClick);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    this.ro = new ResizeObserver(() => {
      this.resize();
    });
    this.ro.observe(canvas.parentElement ?? canvas);

    this.resize();
    this.requestFrame();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    if (this.rangeTimer) clearTimeout(this.rangeTimer);
    this.ro?.disconnect();
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("mouseleave", this.onMouseLeave);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.mini?.removeEventListener("mousedown", this.onMiniDown);
    window.removeEventListener("mousemove", this.onMiniMove);
    window.removeEventListener("mouseup", this.onMiniUp);
  }

  setTheme(mode: ThemeMode): void {
    this.th = vizTheme(mode);
    this.invalidate();
  }

  setTotalSpan(span: number): void {
    this.realTotal = Math.max(span, MIN_SPAN);
    this.rebuildAxis();
    this.totalSpan = Math.max(this.toDisplay(this.realTotal), MIN_SPAN);
    this.target = { begin: 0, end: this.totalSpan };
    this.live = { begin: 0, end: this.totalSpan };
    this.invalidate();
    this.emitRange(true);
  }

  // Between-run idle spans (real us) plus whether to auto-enable compression.
  setBreaks(gaps: { begin: number; end: number }[], enable: boolean): void {
    this.runGaps = [...gaps].sort((a, b) => a.begin - b.begin);
    this.timelapse = enable && this.runGaps.length > 0;
    this.setTotalSpan(this.realTotal);
  }

  hasBreaks(): boolean {
    return this.runGaps.length > 0;
  }

  isTimelapse(): boolean {
    return this.timelapse;
  }

  setTimelapse(on: boolean): void {
    this.timelapse = on && this.runGaps.length > 0;
    this.setTotalSpan(this.realTotal);
    this.resetView();
  }

  private rebuildAxis(): void {
    this.axis = buildTimeAxis(this.runGaps, this.realTotal, this.timelapse);
  }

  private toDisplay(r: number): number {
    return this.axis.toDisplay(r);
  }

  private toReal(dv: number): number {
    return this.axis.toReal(dv);
  }

  // Display us -> screen x (viewport-space, no gap remap).
  private xdOf(d: number): number {
    const span = this.live.end - this.live.begin;
    return GUTTER + ((d - this.live.begin) / span) * this.plotW();
  }

  resetView(): void {
    this.target = { begin: 0, end: this.totalSpan };
    this.scrollY = 0;
    this.invalidate();
    this.emitRange(false);
  }

  getViewport(): Viewport {
    return { begin: this.toReal(this.target.begin), end: this.toReal(this.target.end) };
  }

  // Live plot fraction [0,1] of a real timestamp (timelapse-aware, eased).
  // Used by overlays to place series in sync with the track slices per frame.
  frac(realTs: number): number {
    return (this.xOf(realTs) - GUTTER) / this.plotW();
  }

  // Inverse of frac against the live viewport: real timestamp at a plot fraction.
  realAtFrac(f: number): number {
    return this.toReal(this.live.begin + f * (this.live.end - this.live.begin));
  }

  setSelected(ev: TraceEvent | null): void {
    this.selected = ev;
    this.invalidate();
  }

  // Human-readable label per process id (e.g. resolved host name).
  setProcessLabels(labels: Map<string, string>): void {
    this.processLabels = labels;
    this.layoutLanes();
  }

  // Fork hierarchy: order processes by DFS (children after parent) and record
  // depth + spawn time so lanes indent and spawn arrows can be drawn.
  setProcTree(nodes: ProcTreeNode[]): void {
    this.procOrder = new Map();
    this.procDepth = new Map();
    this.procParent = new Map();
    this.procSpawn = new Map();
    this.procFirst = new Map();
    const children = new Map<number, number[]>();
    const pids = new Set<number>();
    for (const n of nodes) {
      pids.add(n.pid);
      this.procParent.set(n.pid, n.parent);
      this.procSpawn.set(n.pid, n.spawn_ts);
      this.procFirst.set(n.pid, n.first_ts);
      if (n.parent >= 0) {
        const c = children.get(n.parent);
        if (c) c.push(n.pid);
        else children.set(n.parent, [n.pid]);
      }
    }
    const firstTs = new Map(nodes.map((n) => [n.pid, n.first_ts]));
    const byFirst = (a: number, b: number) => (firstTs.get(a) ?? 0) - (firstTs.get(b) ?? 0);
    // Rank-order the roots so procOrder reflects rank; layoutLanes then groups
    // lanes by node and orders nodes by their lowest rank.
    const rankOf = new Map<number, number>();
    for (const n of nodes) {
      const r = n.rank != null && n.rank !== "" ? Number(n.rank) : NaN;
      if (Number.isFinite(r)) rankOf.set(n.pid, r);
    }
    this.hasRanks = rankOf.size > 0;
    const byRank = (a: number, b: number) =>
      (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity) || byFirst(a, b);
    const roots = nodes
      .filter((n) => n.parent < 0 || !pids.has(n.parent))
      .map((n) => n.pid)
      .sort(this.hasRanks ? byRank : byFirst);
    let ord = 0;
    const visit = (pid: number, depth: number) => {
      this.procOrder.set(pid, ord++);
      this.procDepth.set(pid, depth);
      for (const c of (children.get(pid) ?? []).slice().sort(byFirst)) {
        visit(c, depth + 1);
      }
    };
    for (const r of roots) visit(r, 0);
    // The tree usually arrives after the first data render, so re-order the
    // lanes already on screen instead of waiting for the next fetch.
    this.relayoutLanes();
  }

  // Rebuild lanes when the process tree arrives after they were first built in
  // plain pid order.
  private relayoutLanes(): void {
    this.layoutLanes();
  }

  setShowGaps(v: boolean): void {
    this.showGaps = v;
    if (!v) {
      this.hoveredGap = null;
      this.selectedGap = null;
    }
    this.invalidate();
  }

  // Idle periods per lane: the complement of its busy coverage. A density block
  // tiles the full bucket width but is only busy for `total`, so it counts as
  // busy only when total/dur clears IDLE_FRAC; real slices are always busy.
  private computeGaps(): void {
    const IDLE_FRAC = 0.02;
    const byLane = new Map<number, Slice[]>();
    for (const s of this.slices) {
      let a = byLane.get(s.laneIdx);
      if (!a) {
        a = [];
        byLane.set(s.laneIdx, a);
      }
      a.push(s);
    }
    const gaps: Gap[] = [];
    for (const [laneIdx, arr] of byLane) {
      const lane = this.lanes[laneIdx];
      const label = this.processLabels.get(lane.pid) ?? lane.key;
      const busy: Array<[number, number]> = [];
      for (const s of arr) {
        // The synthetic app span covers the whole process lifetime; it is a
        // container, not activity, so it must not mask a lane's idle periods.
        if (s.ev.cat === "dftracer") continue;
        const full = Math.max(s.dur, 0);
        if (s.density && (full <= 0 || Math.min(s.total, full) / full < IDLE_FRAC)) continue;
        busy.push([s.ts, s.ts + full]);
      }
      busy.sort((a, b) => a[0] - b[0]);
      // Tolerance to skip float-rounding slivers between contiguous buckets.
      const eps = this.totalSpan * 1e-6;
      let curEnd = -Infinity;
      let started = false;
      for (const [b0, b1] of busy) {
        if (!started) {
          curEnd = b1;
          started = true;
          continue;
        }
        if (b0 > curEnd + eps) {
          gaps.push({ laneIdx, label, t0: curEnd, t1: b0, dur: b0 - curEnd });
          curEnd = b1;
        } else if (b1 > curEnd) {
          curEnd = b1;
        }
      }
    }
    gaps.sort((a, b) => b.dur - a.dur);
    this.gaps = gaps;
  }

  topGaps(n: number): Gap[] {
    // Resolve the label now (process labels may arrive after computeGaps ran).
    return this.gaps.slice(0, n).map((g) => {
      const lane = this.lanes[g.laneIdx];
      return { ...g, label: this.processLabels.get(lane.pid) ?? lane.key };
    });
  }

  // Zoom to a real-time range (timelapse-aware). focusRange works in display
  // coords; real coords diverge from those once timelapse compresses gaps.
  focusRealRange(t0: number, t1: number): void {
    this.focusRange(this.toDisplay(t0), this.toDisplay(t1));
  }

  focusRange(t0: number, t1: number): void {
    const pad = Math.max((t1 - t0) * 0.3, 1);
    const begin = clamp(t0 - pad, 0, this.totalSpan);
    const end = clamp(t1 + pad, 0, this.totalSpan);
    if (end > begin) {
      this.target = { begin, end };
      this.invalidate();
      this.emitRange(false);
    }
  }

  private renderGaps(ctx: CanvasRenderingContext2D): void {
    if (!this.showGaps) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER_H, this.cssW - GUTTER, this.cssH - RULER_H);
    ctx.clip();
    const active = this.selectedGap ?? this.hoveredGap;
    for (const g of this.gaps) {
      const x0 = this.xOf(g.t0);
      const x1 = this.xOf(g.t1);
      if (x1 - x0 < 3) continue;
      if (x1 < GUTTER || x0 > this.cssW) continue;
      const lane = this.lanes[g.laneIdx];
      const y = RULER_H - this.scrollY + lane.y;
      const hh = lane.rows * ROW_H;
      if (y + hh < RULER_H || y > this.cssH) continue;
      const x = Math.max(x0, GUTTER);
      const w = Math.min(x1, this.cssW) - x;
      const yy = Math.max(y, RULER_H);
      const on = g === active;
      ctx.fillStyle = on ? this.th.gapActiveFill : this.th.gapFill;
      ctx.fillRect(x, yy, w, hh - (y < RULER_H ? RULER_H - y : 0));
      if (on) {
        ctx.strokeStyle = this.th.gapStroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, yy + 0.5, w - 1, hh - 1 - (y < RULER_H ? RULER_H - y : 0));
      }
    }
    ctx.restore();
    if (active) this.renderGapReadout(ctx, active);
  }

  private renderGapReadout(ctx: CanvasRenderingContext2D, g: Gap): void {
    const x0 = this.xOf(g.t0);
    const x1 = this.xOf(g.t1);
    const lane = this.lanes[g.laneIdx];
    const y = RULER_H - this.scrollY + lane.y;
    const label = `idle ${formatTime(g.dur)}`;
    ctx.save();
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    const tw = ctx.measureText(label).width;
    const padX = 6;
    const bw = tw + padX * 2;
    const bh = 18;
    const bx = clamp((x0 + x1) / 2 - bw / 2, GUTTER + 2, this.cssW - bw - 2);
    const by = clamp(y - bh - 4, RULER_H + 2, this.cssH - bh - 2);
    ctx.fillStyle = this.th.ttBg;
    ctx.strokeStyle = this.th.gapStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = this.th.gapStroke;
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + padX, by + bh / 2 + 0.5);
    ctx.restore();
  }

  setSearch(term: string): number {
    this.searchTerm = term.trim().toLowerCase();
    this.searchIdx = -1;
    this.recomputeMatches();
    this.invalidate();
    return this.searchMatches.length;
  }

  private recomputeMatches(): void {
    this.searchMatches = [];
    this.searchMatchSet = new Set();
    if (!this.searchTerm) return;
    for (const s of this.slices) {
      if (sliceKey(s.ev).toLowerCase().includes(this.searchTerm)) {
        this.searchMatches.push(s);
        this.searchMatchSet.add(s);
      }
    }
    this.searchMatches.sort((a, b) => a.ts - b.ts);
  }

  // Move to the next/prev match, centering the viewport and selecting it.
  // Returns the 1-based match position (0 if none).
  focusMatch(dir: 1 | -1): number {
    const n = this.searchMatches.length;
    if (n === 0) return 0;
    this.searchIdx = (this.searchIdx + dir + n) % n;
    const s = this.searchMatches[this.searchIdx];
    const center = this.toDisplay(s.ts + s.dur / 2);
    const span = this.target.end - this.target.begin;
    const begin = clamp(center - span / 2, 0, Math.max(0, this.totalSpan - span));
    this.target = { begin, end: begin + span };
    this.selected = s.ev;
    this.cb.onSelect?.(s.ev);
    this.invalidate();
    this.emitRange(false);
    return this.searchIdx + 1;
  }

  setData(events: TraceEvent[], density: DensityBlock[] = []): void {
    const byLane = new Map<string, Slice[]>();
    const push = (key: string, s: Slice) => {
      let arr = byLane.get(key);
      if (!arr) {
        arr = [];
        byLane.set(key, arr);
      }
      arr.push(s);
    };
    for (const ev of events) {
      if (ev.ph === "M") continue; // metadata
      const ts = num(ev.ts);
      const dur = num(ev.dur);
      if (!Number.isFinite(ts) || dur < 0) continue;
      push(`${ev.pid}/${ev.tid}`, {
        ev,
        ts,
        dur,
        laneIdx: 0,
        depth: 0,
        sdepth: typeof ev.depth === "number" ? ev.depth : -1,
        count: 1,
        total: dur,
        density: false,
      });
    }
    // Aggregated density blocks render as slices too.
    for (const b of density) {
      const synthetic = {
        name: b.name,
        cat: "",
        pid: b.pid,
        tid: b.tid,
        ts: b.ts,
        dur: b.dur,
        ph: "X",
        args: {},
        count: b.count,
        total: b.total,
        aggregated: true,
      } as unknown as TraceEvent;
      push(`${b.pid}/${b.tid}`, {
        ev: synthetic,
        ts: b.ts,
        dur: b.dur,
        laneIdx: 0,
        depth: 0,
        sdepth: typeof b.depth === "number" ? b.depth : -1,
        count: b.count,
        total: b.total,
        density: true,
      });
    }

    // Persist every lane so tracks don't vanish when they have no events in the
    // current window (Perfetto keeps them). New lanes are added, never removed.
    for (const k of byLane.keys()) this.laneRegistry.add(k);
    this.slicesByKey = byLane;
    this.layoutLanes();
  }

  // Merge, never replace: the per-window HH scan is empty at full view and
  // would otherwise wipe the proctree-provided host map.
  setHosts(hosts: Map<number, string>): void {
    let changed = false;
    for (const [pid, host] of hosts) {
      if (this.hostByPid.get(pid) !== host) {
        this.hostByPid.set(pid, host);
        changed = true;
      }
    }
    if (changed) this.layoutLanes();
  }

  setBytes(bytes: Map<number, number>): void {
    this.bytesByPid = bytes;
    this.invalidate();
  }

  toggleCollapse(key: string): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.layoutLanes();
  }

  // Build the gutter tree: host -> process (fork DFS) -> thread. Collapsed
  // groups fold their descendants' slices into one summary row so load still
  // shows. Assigns each slice a target lane + stack depth and flows y.
  private layoutLanes(): void {
    const orderOf = (pid: number) => this.procOrder.get(pid) ?? 1e9 + pid;
    // Band by node/host. procOrder is rank-ordered, so bands sort by their
    // lowest rank (below) and lanes within a band sort by rank.
    const hostOf = (pid: number) => this.hostByPid.get(pid) ?? "unknown";
    const parentOf = (pid: number) => this.procParent.get(pid);

    const pids = new Set<number>();
    const tidsByPid = new Map<number, string[]>();
    for (const k of this.laneRegistry) {
      const slash = k.indexOf("/");
      const pid = Number(k.slice(0, slash));
      pids.add(pid);
      let a = tidsByPid.get(pid);
      if (!a) {
        a = [];
        tidsByPid.set(pid, a);
      }
      a.push(k.slice(slash + 1));
    }
    for (const a of tidsByPid.values()) a.sort((x, y) => Number(x) - Number(y));

    const inHost = (pid: number, h: string) => pids.has(pid) && hostOf(pid) === h;
    const childrenOf = new Map<number, number[]>();
    for (const pid of pids) {
      const par = parentOf(pid);
      if (par != null && par >= 0 && inHost(par, hostOf(pid))) {
        let a = childrenOf.get(par);
        if (!a) {
          a = [];
          childrenOf.set(par, a);
        }
        a.push(pid);
      }
    }
    for (const a of childrenOf.values()) a.sort((x, y) => orderOf(x) - orderOf(y));

    const hostPids = new Map<string, number[]>();
    for (const pid of pids) {
      const h = hostOf(pid);
      let a = hostPids.get(h);
      if (!a) {
        a = [];
        hostPids.set(h, a);
      }
      a.push(pid);
    }
    const hosts = [...hostPids.keys()].sort((a, b) => {
      const ma = Math.min(...hostPids.get(a)!.map(orderOf));
      const mb = Math.min(...hostPids.get(b)!.map(orderOf));
      return ma - mb || (a < b ? -1 : 1);
    });
    this.hostPids = hostPids;

    const lanes: Lane[] = [];
    const targetOf = new Map<string, number>(); // pid/tid -> lane index
    const collapsedH = (h: string) => this.collapsed.has("host:" + h);
    const collapsedP = (p: number) => this.collapsed.has("pid:" + p);
    const routeAll = (pid: number, idx: number) => {
      for (const t of tidsByPid.get(pid) ?? []) targetOf.set(pid + "/" + t, idx);
      for (const c of childrenOf.get(pid) ?? []) routeAll(c, idx);
    };

    for (const host of hosts) {
      const hIdx = lanes.length;
      const singleHost = hosts.length === 1 && host === "unknown";
      if (!singleHost) {
        lanes.push({
          key: "host:" + host,
          pid: "",
          tid: "",
          rows: 1 + this.nodeStripBoost,
          y: 0,
          kind: "host",
          label: host,
          indent: 0,
          collapsible: true,
          collapseKey: "host:" + host,
          flatten: true,
          host,
          processFirst: true,
          soleThread: false,
          depth: 0,
        });
        if (collapsedH(host)) {
          for (const pid of hostPids.get(host)!) routeAll(pid, hIdx);
          continue;
        }
      }
      const base = singleHost ? 0 : 1;
      const roots = hostPids
        .get(host)!
        .filter((pid) => {
          const par = parentOf(pid);
          return !(par != null && par >= 0 && inHost(par, host));
        })
        .sort((a, b) => orderOf(a) - orderOf(b));

      const walk = (pid: number, d: number): void => {
        const tids = tidsByPid.get(pid) ?? [];
        const sole = tids.length === 1;
        const kids = childrenOf.get(pid) ?? [];
        const collapsed = collapsedP(pid);
        const pIdx = lanes.length;
        lanes.push({
          key: "pid:" + pid,
          pid: String(pid),
          tid: sole ? tids[0] : "",
          rows: 1,
          y: 0,
          kind: "proc",
          label: this.processLabels.get(String(pid)) ?? "proc " + pid,
          indent: (base + d) * TWIST_W,
          collapsible: true,
          collapseKey: "pid:" + pid,
          flatten: collapsed,
          host,
          processFirst: true,
          soleThread: sole,
          depth: d,
        });
        if (collapsed) {
          routeAll(pid, pIdx);
          return;
        }
        if (sole) {
          targetOf.set(pid + "/" + tids[0], pIdx);
        } else {
          for (const t of tids) {
            targetOf.set(pid + "/" + t, lanes.length);
            lanes.push({
              key: pid + "/" + t,
              pid: String(pid),
              tid: t,
              rows: 1,
              y: 0,
              kind: "thread",
              label: "thread " + t,
              indent: (base + d + 1) * TWIST_W,
              collapsible: false,
              collapseKey: "",
              flatten: false,
              host,
              processFirst: false,
              soleThread: false,
              depth: d,
            });
          }
        }
        for (const c of kids) walk(c, d + 1);
      };
      for (const r of roots) walk(r, 0);
    }

    const slices: Slice[] = [];
    const openByLane = new Map<number, number[]>();
    for (const [key, arr] of this.slicesByKey) {
      const idx = targetOf.get(key);
      if (idx == null) continue;
      const lane = lanes[idx];
      arr.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
      let open = openByLane.get(idx);
      if (!open) {
        open = [];
        openByLane.set(idx, open);
      }
      for (const s of arr) {
        while (open.length && open[open.length - 1] <= s.ts) open.pop();
        s.laneIdx = idx;
        // Prefer the server-computed depth (stable across zoom); fall back to
        // the client stack for data sources that do not supply one.
        if (lane.flatten) s.depth = 0;
        else if (s.sdepth >= 0) s.depth = s.sdepth;
        else s.depth = open.length;
        if (!s.density && !lane.flatten && s.sdepth < 0) open.push(s.ts + Math.max(s.dur, 0));
        lane.rows = Math.max(lane.rows, s.depth + 1);
        slices.push(s);
      }
    }

    let y = 0;
    let prevKind = "";
    for (const lane of lanes) {
      if (lane.kind === "host" && prevKind) y += HOST_GAP;
      lane.y = y;
      y += lane.rows * ROW_H + LANE_GAP;
      prevKind = lane.kind;
    }

    this.slices = slices;
    this.lanes = lanes;
    this.contentH = y;
    this.computeMetricDomains();
    this.computeMiniActivity();
    this.recomputeMatches();
    this.computeGaps();
    this.clampScroll();
    this.invalidate();
  }

  setColorMode(mode: "category" | "size" | "latency"): void {
    this.colorMode = mode;
    this.invalidate();
  }

  get colorMetric(): string {
    return this.colorMode;
  }

  private retOf(s: Slice): number | null {
    const ret = s.ev.args?.ret as unknown;
    const n = typeof ret === "number" ? ret : typeof ret === "string" ? Number(ret) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  private computeMetricDomains(): void {
    let dLo = Infinity,
      dHi = 1,
      sLo = Infinity,
      sHi = 1;
    for (const s of this.slices) {
      const d = s.density ? (s.count ? s.total / s.count : 0) : s.dur;
      if (d > 0) {
        dLo = Math.min(dLo, d);
        dHi = Math.max(dHi, d);
      }
      if (!s.density) {
        const r = this.retOf(s);
        if (r != null && r > 0) {
          sLo = Math.min(sLo, r);
          sHi = Math.max(sHi, r);
        }
      }
    }
    this.durDomain = [Math.log(Number.isFinite(dLo) ? dLo : 1), Math.log(dHi)];
    this.sizeDomain = [Math.log(Number.isFinite(sLo) ? sLo : 1), Math.log(sHi)];
  }

  // Sequential ramp: dark base -> bright hue as the (log-normalized) metric rises.
  private ramp(t: number, kind: "lat" | "size"): string {
    const a = kind === "lat" ? [26, 42, 48] : [48, 38, 20];
    const b = kind === "lat" ? [92, 200, 224] : [244, 176, 66];
    const c = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * c)},${Math.round(
      a[1] + (b[1] - a[1]) * c,
    )},${Math.round(a[2] + (b[2] - a[2]) * c)})`;
  }

  private metricFill(s: Slice): string | null {
    if (this.colorMode === "category") return null;
    const NEUTRAL = "#3a3f36";
    const norm = (v: number, dom: [number, number]) =>
      dom[1] > dom[0] ? (v - dom[0]) / (dom[1] - dom[0]) : 0.5;
    if (this.colorMode === "latency") {
      const d = s.density ? (s.count ? s.total / s.count : 0) : s.dur;
      return d > 0 ? this.ramp(norm(Math.log(d), this.durDomain), "lat") : NEUTRAL;
    }
    if (s.density) return NEUTRAL; // per-event bytes are not available once aggregated
    const r = this.retOf(s);
    return r != null && r > 0 ? this.ramp(norm(Math.log(r), this.sizeDomain), "size") : NEUTRAL;
  }

  private plotW(): number {
    return Math.max(1, this.cssW - GUTTER);
  }

  private xOf(ts: number): number {
    return this.xdOf(this.toDisplay(ts));
  }

  private timeOf(x: number): number {
    const span = this.live.end - this.live.begin;
    return this.live.begin + ((x - GUTTER) / this.plotW()) * span;
  }

  private localPos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Perfetto-style wheel/trackpad: Ctrl/Cmd+wheel or trackpad pinch (macOS
  // reports pinch as ctrl+wheel) zooms at the cursor; horizontal swipe or
  // Shift+wheel pans time; vertical swipe scrolls lanes.
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x } = this.localPos(e);
    if (e.ctrlKey || e.metaKey) {
      // Normalize line/page wheel modes to pixels, then accumulate; the rAF loop
      // applies the coalesced delta so bursts don't leap.
      const dy =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * this.cssH : e.deltaY;
      this.pendingZoom += dy;
      this.zoomFocusX = x;
      this.requestFrame();
      return;
    }
    const span = this.target.end - this.target.begin;
    // Shift makes a vertical wheel pan horizontally (mouse-wheel users).
    const panDelta = e.shiftKey ? e.deltaY : e.deltaX;
    if (panDelta !== 0) {
      this.panBy((panDelta / this.plotW()) * span);
    }
    if (!e.shiftKey && e.deltaY !== 0) {
      this.scrollY += e.deltaY;
      this.clampScroll();
      this.invalidate();
    }
  };

  private zoomAt(x: number, deltaY: number): void {
    const anchor = this.timeOf(x);
    const span = this.target.end - this.target.begin;
    const factor = Math.exp(deltaY * ZOOM_SENSITIVITY);
    const newSpan = clamp(span * factor, MIN_SPAN, this.totalSpan);
    const frac = clamp((anchor - this.target.begin) / span, 0, 1);
    let begin = anchor - frac * newSpan;
    let end = begin + newSpan;
    if (begin < 0) {
      begin = 0;
      end = newSpan;
    }
    if (end > this.totalSpan) {
      end = this.totalSpan;
      begin = end - newSpan;
    }
    this.target = { begin, end };
    this.invalidate();
    this.emitRange(false);
  }

  private panBy(dt: number): void {
    const span = this.target.end - this.target.begin;
    const begin = clamp(this.target.begin + dt, 0, Math.max(0, this.totalSpan - span));
    this.target = { begin, end: begin + span };
    this.invalidate();
    this.emitRange(false);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    const k = e.key.toLowerCase();
    if (NAV_KEYS.has(k)) {
      this.keys.add(k);
      e.preventDefault();
      this.requestFrame(); // start the animation loop while keys are held
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  // Continuous WASD/arrow navigation, applied once per animation frame so held
  // keys pan/zoom smoothly (Perfetto-style: A/D pan, W/S zoom at the cursor).
  private applyKeys(): void {
    if (this.keys.size === 0) return;
    const span = this.target.end - this.target.begin;
    if (this.keys.has("a") || this.keys.has("arrowleft")) this.panBy(-span * 0.02);
    if (this.keys.has("d") || this.keys.has("arrowright")) this.panBy(span * 0.02);
    if (this.keys.has("w") || this.keys.has("arrowup")) this.zoomAt(this.mouseX, -10);
    if (this.keys.has("s") || this.keys.has("arrowdown")) this.zoomAt(this.mouseX, 10);
  }

  private onMouseDown = (e: MouseEvent): void => {
    const { x, y } = this.localPos(e);
    // Drag on the ruler, or Shift+drag anywhere, selects a time range for stats.
    if (x >= GUTTER && (y < RULER_H || e.shiftKey)) {
      this.selecting = true;
      this.selAnchorT = this.timeOf(x);
      this.selection = { t0: this.selAnchorT, t1: this.selAnchorT };
      this.invalidate();
      return;
    }
    if (x < GUTTER && y > RULER_H) {
      // Gutter: a potential collapse click; never a pan/scroll drag.
      this.gutterDown = { x, y };
      return;
    }
    this.dragging = true;
    this.moved = false;
    this.lastX = x;
    this.lastY = y;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const { x, y } = this.localPos(e);
    this.mouseX = x;
    if (this.selecting) {
      const t = clamp(this.timeOf(x), 0, this.totalSpan);
      this.selection = {
        t0: Math.min(this.selAnchorT, t),
        t1: Math.max(this.selAnchorT, t),
      };
      this.invalidate();
      return;
    }
    if (this.dragging) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      const span = this.target.end - this.target.begin;
      const dt = -(dx / this.plotW()) * span;
      const begin = clamp(this.target.begin + dt, 0, this.totalSpan - span);
      this.target = { begin, end: begin + span };
      this.scrollY -= dy;
      this.clampScroll();
      this.lastX = x;
      this.lastY = y;
      this.invalidate();
      this.emitRange(false);
      return;
    }
    // Off-canvas (window mousemove fires during drags): no hover. Leaves the
    // header-help alone so HTML metric labels can own it off-canvas.
    if (x < 0 || x > this.cssW || y < 0 || y > this.cssH) {
      if (this.hovered || this.hoveredGap || this.nodeStripHoverAt) {
        this.hovered = null;
        this.hoveredGap = null;
        this.nodeStripHoverAt = null;
        this.invalidate();
      }
      this.cursorInside = false;
      this.cb.onHover?.(null, 0, 0);
      return;
    }
    this.cursorInside = x >= GUTTER && y >= RULER_H && x <= this.cssW;
    if (this.cursorInside) this.canvas.style.cursor = "crosshair";
    else if (x < GUTTER && y > RULER_H && this.gutterRowAt(y)) this.canvas.style.cursor = "pointer";
    else this.canvas.style.cursor = "default";
    const hit = this.hitTest(x, y);
    const gap = hit ? null : this.gapAt(x, y);
    const strip = hit ? null : this.nodeStripAt(x, y);
    if (strip || this.nodeStripBadgeAt(x, y)) this.canvas.style.cursor = "pointer";
    const stripHover = strip ? { host: strip.host, i: strip.i } : null;
    if (
      stripHover?.host !== this.nodeStripHoverAt?.host ||
      stripHover?.i !== this.nodeStripHoverAt?.i
    ) {
      this.nodeStripHoverAt = stripHover;
      this.invalidate();
    }
    if (hit !== this.hovered || gap !== this.hoveredGap || this.cursorInside) {
      this.hovered = hit;
      this.hoveredGap = gap;
      this.invalidate();
    }
    this.cb.onHover?.(hit?.ev ?? null, e.clientX, e.clientY);
    this.cb.onHeaderHover?.(this.headerKeyAt(x, y), e.clientX, e.clientY);
    let stripText: string | null = null;
    if (strip) {
      const parts = strip.comps.map((c) => {
        const v = c.values[strip.i] ?? 0;
        return `${c.key} ${c.key.endsWith("_pct") ? `${v.toFixed(1)}%` : v.toFixed(1)}`;
      });
      const n = strip.comps[0]?.counts?.[strip.i] ?? 0;
      stripText = `${this.nodeStripLabel ?? ""}  ${parts.join(" · ")}${n > 1 ? ` · avg of ${n}` : ""}`;
    }
    this.cb.onNodeStripHover?.(stripText, e.clientX, e.clientY);
  };

  // Gutter column-header key under the cursor (for metric help tooltips).
  private headerKeyAt(x: number, y: number): string | null {
    if (y > RULER_H || x > GUTTER) return null;
    if (x < 120) return "track";
    if (x < 228) return "i/o util";
    if (x < 288) return "ops";
    return "bytes";
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (this.gutterDown) {
      const g = this.gutterDown;
      this.gutterDown = null;
      const { x, y } = this.localPos(e);
      if (Math.abs(x - g.x) + Math.abs(y - g.y) < 4) {
        const row = this.gutterRowAt(y);
        if (row?.collapsible) this.toggleCollapse(row.collapseKey);
      }
      return;
    }
    if (this.selecting) {
      this.selecting = false;
      const sel = this.selection;
      const span = this.live.end - this.live.begin;
      if (sel && sel.t1 - sel.t0 > span * 0.002) {
        this.cb.onSelectRange?.(this.toReal(sel.t0), this.toReal(sel.t1));
      } else {
        this.selection = null;
        this.cb.onSelectRangeClear?.();
      }
      this.invalidate();
      return;
    }
    if (this.dragging && !this.moved) {
      const { x, y } = this.localPos(e);
      if (this.nodeStripBadgeAt(x, y)) {
        this.cb.onNodeStripClick?.();
        this.dragging = false;
        return;
      }
      const hit = this.hitTest(x, y);
      if (!hit) {
        const strip = this.nodeStripEventAt(x, y);
        if (strip) {
          this.selectedGap = null;
          this.selected = strip;
          this.cb.onSelect?.(strip);
          this.invalidate();
          this.dragging = false;
          return;
        }
      }
      // A click on empty plot clears both the picked event and any range.
      if (!hit && x > GUTTER && this.selection) {
        this.selection = null;
        this.cb.onSelectRangeClear?.();
      }
      this.selectedGap = hit ? null : this.gapAt(x, y);
      this.selected = hit?.ev ?? null;
      this.cb.onSelect?.(this.selected);
      this.invalidate();
    }
    this.dragging = false;
  };

  hasSelection(): boolean {
    return this.selection !== null;
  }

  clearSelection(): void {
    this.selection = null;
    this.invalidate();
  }

  private onMouseLeave = (): void => {
    this.cursorInside = false;
    if (this.hovered) this.hovered = null;
    this.invalidate();
    this.cb.onHover?.(null, 0, 0);
    this.cb.onHeaderHover?.(null, 0, 0);
  };

  private onDblClick = (e: WheelEvent | MouseEvent): void => {
    const { x } = this.localPos(e as MouseEvent);
    const anchor = this.timeOf(x);
    const span = this.target.end - this.target.begin;
    const newSpan = clamp(span * 0.4, MIN_SPAN, this.totalSpan);
    const begin = clamp(anchor - newSpan / 2, 0, this.totalSpan - newSpan);
    this.target = { begin, end: begin + newSpan };
    this.invalidate();
    this.emitRange(false);
  };

  private hitTest(x: number, y: number): Slice | null {
    if (x < GUTTER || y < RULER_H) return null;
    let best: Slice | null = null;
    for (const s of this.slices) {
      const sx = this.xOf(s.ts);
      const sw = Math.max(this.xOf(s.ts + s.dur) - sx, 1);
      if (x < sx || x > sx + sw) continue;
      const lane = this.lanes[s.laneIdx];
      const sy = RULER_H - this.scrollY + lane.y + s.depth * ROW_H;
      if (y < sy || y > sy + ROW_H) continue;
      if (!best || s.depth >= best.depth) best = s;
    }
    return best;
  }

  // Topmost visible gap under the cursor (only when gaps are shown).
  private gapAt(x: number, y: number): Gap | null {
    if (!this.showGaps || x < GUTTER || y < RULER_H) return null;
    let best: Gap | null = null;
    for (const g of this.gaps) {
      const x0 = this.xOf(g.t0);
      const x1 = this.xOf(g.t1);
      if (x1 - x0 < 3 || x < x0 || x > x1) continue;
      const lane = this.lanes[g.laneIdx];
      const gy = RULER_H - this.scrollY + lane.y;
      const gh = lane.rows * ROW_H;
      if (y < gy || y > gy + gh) continue;
      // Smallest gap wins: nested lanes overlap, favor the most specific.
      if (!best || g.dur < best.dur) best = g;
    }
    return best;
  }

  private clampScroll(): void {
    const maxScroll = Math.max(0, this.contentH - (this.cssH - RULER_H));
    this.scrollY = clamp(this.scrollY, 0, maxScroll);
  }

  private emitRange(immediate: boolean): void {
    if (this.rangeTimer) clearTimeout(this.rangeTimer);
    const fire = () =>
      this.cb.onRangeChange?.(this.toReal(this.target.begin), this.toReal(this.target.end));
    if (immediate) {
      fire();
    } else {
      this.rangeTimer = window.setTimeout(fire, RANGE_DEBOUNCE_MS);
    }
  }

  // Pixels actually drawn across; the server folds anything narrower than one.
  // The canvas may be unsized when hidden (e.g. the timeline tab is not the
  // active view yet), so fall back to the parent width or the window width so
  // callers like the overview density never collapse to a single bucket.
  viewportWidth(): number {
    const drawn = this.canvas.width || Math.round(this.cssW * this.dpr);
    if (drawn > 1) return drawn;
    const dpr = window.devicePixelRatio || 1;
    const parentW = this.canvas.parentElement?.clientWidth ?? 0;
    return Math.max(1, Math.round((parentW || window.innerWidth) * dpr));
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    const w = parent ? parent.clientWidth : this.canvas.clientWidth;
    const h = parent ? parent.clientHeight : this.canvas.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.clampScroll();
    this.resizeMini();
    this.resizeCounters();
    this.invalidate();
  }

  attachMinimap(canvas: HTMLCanvasElement): void {
    this.mini = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    this.miniCtx = ctx;
    canvas.addEventListener("mousedown", this.onMiniDown);
    window.addEventListener("mousemove", this.onMiniMove);
    window.addEventListener("mouseup", this.onMiniUp);
    const ro = new ResizeObserver(() => this.resizeMini());
    ro.observe(canvas.parentElement ?? canvas);
    this.resizeMini();
  }

  private resizeMini(): void {
    const c = this.mini;
    if (!c) return;
    const parent = c.parentElement;
    const w = parent ? parent.clientWidth : c.clientWidth;
    const h = parent ? parent.clientHeight : c.clientHeight;
    this.miniW = w;
    this.miniH = h;
    c.width = Math.round(w * this.dpr);
    c.height = Math.round(h * this.dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    this.invalidate();
  }

  private computeMiniActivity(): void {
    const acc = new Array(MINI_COLS).fill(0);
    const span = this.totalSpan || 1;
    for (const s of this.slices) {
      const c = clamp(Math.floor((s.ts / span) * MINI_COLS), 0, MINI_COLS - 1);
      acc[c] += s.total;
    }
    let max = 1;
    for (const v of acc) if (v > max) max = v;
    this.miniActivity = acc;
    this.miniActivityMax = max;
  }

  // Whole-trace per-lane activity (density blocks over [0, totalSpan]) so the
  // minimap mirrors the track stack (grouping + where each process is busy).
  setOverview(blocks: DensityBlock[]): void {
    const byLane = new Map<string, Float64Array>();
    const span = this.totalSpan || 1;
    let max = 1;
    for (const b of blocks) {
      const key = `${b.pid}/${b.tid}`;
      let arr = byLane.get(key);
      if (!arr) {
        arr = new Float64Array(MINI_COLS);
        byLane.set(key, arr);
      }
      const c = clamp(Math.floor((b.ts / span) * MINI_COLS), 0, MINI_COLS - 1);
      arr[c] += b.total || b.count || 0;
      if (arr[c] > max) max = arr[c];
    }
    const ops = new Map<number, number>();
    for (const b of blocks) ops.set(b.pid, (ops.get(b.pid) ?? 0) + (b.count || 0));
    this.ovOpsByPid = ops;
    this.overviewLanes = byLane;
    this.overviewMax = max;
    this.invalidate();
  }

  // Per-process I/O busy time (us), from the proctree scan.
  setIoBusy(busyUs: Map<number, number>): void {
    this.ioBusyByPid = busyUs;
    this.invalidate();
  }

  private renderMinimap(): void {
    const ctx = this.miniCtx;
    if (!ctx) return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.miniW, this.miniH);
    ctx.fillStyle = this.th.plotBg;
    ctx.fillRect(0, 0, this.miniW, this.miniH);

    if (this.overviewLanes.size > 0) {
      this.renderMiniLanes(ctx);
    } else {
      const cols = this.miniActivity.length;
      const bw = this.miniW / cols;
      ctx.fillStyle = this.th.ruler;
      for (let i = 0; i < cols; i++) {
        const v = this.miniActivity[i] / this.miniActivityMax;
        if (v <= 0) continue;
        const h = Math.max(1, v * (this.miniH - 4));
        ctx.fillRect(i * bw, this.miniH - 2 - h, Math.max(1, bw), h);
      }
    }

    const x0 = (this.live.begin / this.totalSpan) * this.miniW;
    const x1 = (this.live.end / this.totalSpan) * this.miniW;
    const w = Math.max(2, x1 - x0);
    ctx.fillStyle = this.th.selFill;
    ctx.fillRect(x0, 0, w, this.miniH);
    ctx.strokeStyle = this.th.selStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, 0.5, w - 1, this.miniH - 1);

    if (this.miniSel) {
      const sx0 = (this.miniSel.t0 / this.totalSpan) * this.miniW;
      const sx1 = (this.miniSel.t1 / this.totalSpan) * this.miniW;
      const sw = Math.max(1, sx1 - sx0);
      ctx.fillStyle = this.th.selFill;
      ctx.fillRect(sx0, 0, sw, this.miniH);
      ctx.strokeStyle = this.th.selStroke;
      ctx.strokeRect(sx0 + 0.5, 0.5, sw - 1, this.miniH - 1);
    }
    ctx.restore();
  }

  // A scaled-down heatmap of the track stack: one thin row per lane in the same
  // fork-DFS order (with process gaps), activity intensity along time.
  private renderMiniLanes(ctx: CanvasRenderingContext2D): void {
    const orderOf = (pid: number) => this.procOrder.get(pid) ?? 1e9 + pid;
    const keys = [...this.overviewLanes.keys()].sort((a, b) => {
      const [pa, ta] = a.split("/").map(Number);
      const [pb, tb] = b.split("/").map(Number);
      return orderOf(pa) - orderOf(pb) || ta - tb;
    });
    const n = keys.length;
    if (n === 0) return;

    const top = 1;
    const bot = this.miniH - 1;
    if (n > bot - top) {
      this.renderMiniAggregate(ctx, top, bot);
      return;
    }
    const newProc = new Array<boolean>(n);
    let ngap = 0;
    let prevPid = "";
    for (let i = 0; i < n; i++) {
      const pid = keys[i].slice(0, keys[i].indexOf("/"));
      const isNew = i > 0 && pid !== prevPid;
      newProc[i] = isNew;
      if (isNew) ngap++;
      prevPid = pid;
    }
    const gap = n <= 48 ? 1 : 0;
    const rowH = Math.max(1, (bot - top - ngap * gap) / n);
    const bw = this.miniW / MINI_COLS;
    const denom = Math.log(this.overviewMax + 1) || 1;

    let y = top;
    for (let i = 0; i < n; i++) {
      if (newProc[i]) y += gap;
      const arr = this.overviewLanes.get(keys[i]) as Float64Array;
      ctx.fillStyle = this.th.miniIdle; // idle-lane baseline
      ctx.fillRect(0, y, this.miniW, rowH);
      for (let c = 0; c < MINI_COLS; c++) {
        const raw = arr[c];
        if (raw <= 0) continue;
        const v = Math.log(raw + 1) / denom; // log so light activity shows
        ctx.fillStyle = `rgba(${this.th.miniActivity},${0.25 + 0.65 * Math.min(1, v)})`;
        ctx.fillRect(c * bw, y, Math.max(1, bw), rowH);
      }
      y += rowH;
    }
  }

  // Too many lanes to give each a visible row: collapse to a single time-density
  // heatmap (activity summed across all lanes per column), always fully visible.
  private renderMiniAggregate(ctx: CanvasRenderingContext2D, top: number, bot: number): void {
    const col = new Float64Array(MINI_COLS);
    let max = 1;
    for (const arr of this.overviewLanes.values()) {
      for (let c = 0; c < MINI_COLS; c++) {
        col[c] += arr[c];
        if (col[c] > max) max = col[c];
      }
    }
    const bw = this.miniW / MINI_COLS;
    const denom = Math.log(max + 1) || 1;
    const avail = bot - top;
    ctx.fillStyle = this.th.miniIdle;
    ctx.fillRect(0, top, this.miniW, avail);
    for (let c = 0; c < MINI_COLS; c++) {
      if (col[c] <= 0) continue;
      const v = Math.min(1, Math.log(col[c] + 1) / denom);
      const h = Math.max(1, v * avail);
      ctx.fillStyle = `rgba(${this.th.miniActivity},${0.35 + 0.55 * v})`;
      ctx.fillRect(c * bw, bot - h, Math.max(1, bw), h);
    }
  }

  private miniTimeAt(e: MouseEvent): number {
    if (!this.mini) return 0;
    const r = this.mini.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, this.miniW);
    return (x / this.miniW) * this.totalSpan;
  }

  private centerViewportAt(t: number): void {
    const span = this.target.end - this.target.begin;
    const begin = clamp(t - span / 2, 0, Math.max(0, this.totalSpan - span));
    this.target = { begin, end: begin + span };
    this.invalidate();
    this.emitRange(false);
  }

  private onMiniDown = (e: MouseEvent): void => {
    if (!this.mini) return;
    e.preventDefault();
    this.miniDragging = true;
    this.miniMoved = false;
    this.miniAnchorT = this.miniTimeAt(e);
    this.miniAnchorX = e.clientX;
    this.miniSel = null;
  };

  private onMiniMove = (e: MouseEvent): void => {
    if (!this.miniDragging) return;
    if (Math.abs(e.clientX - this.miniAnchorX) > 3) this.miniMoved = true;
    if (this.miniMoved) {
      // Drag paints a selection region; releasing zooms the viewport to it.
      const t = this.miniTimeAt(e);
      this.miniSel = {
        t0: Math.min(this.miniAnchorT, t),
        t1: Math.max(this.miniAnchorT, t),
      };
      this.invalidate();
    }
  };

  private onMiniUp = (): void => {
    if (this.miniDragging && this.miniMoved && this.miniSel) {
      const { t0, t1 } = this.miniSel;
      const begin = clamp(t0, 0, this.totalSpan);
      const end = clamp(Math.max(t1, begin + MIN_SPAN), 0, this.totalSpan);
      this.target = { begin, end };
      this.invalidate();
      this.emitRange(false);
    } else if (this.miniDragging && !this.miniMoved) {
      this.centerViewportAt(this.miniAnchorT); // plain click: jump/center
    }
    this.miniDragging = false;
    this.miniSel = null;
    this.invalidate();
  };

  attachCounters(canvas: HTMLCanvasElement): void {
    this.counterCanvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    this.counterCtx = ctx;
    const ro = new ResizeObserver(() => this.resizeCounters());
    ro.observe(canvas.parentElement ?? canvas);
    this.resizeCounters();
  }

  private resizeCounters(): void {
    const c = this.counterCanvas;
    if (!c) return;
    const parent = c.parentElement;
    const w = parent ? parent.clientWidth : c.clientWidth;
    const h = parent ? parent.clientHeight : c.clientHeight;
    this.counterW = w;
    this.counterH = h;
    c.width = Math.round(w * this.dpr);
    c.height = Math.round(h * this.dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    this.invalidate();
  }

  setCounters(begin: number, bucketUs: number, read: number[], write: number[]): void {
    this.counters = { begin, bucketUs, read, write };
    const perSec = bucketUs > 0 ? 1e6 / bucketUs : 0;
    let peak = 1;
    for (let i = 0; i < read.length; i++) {
      const bw = (read[i] + write[i]) * perSec;
      if (bw > peak) peak = bw;
    }
    this.counterPeak = peak;
    this.invalidate();
  }

  // Dock a per-pid counter split as lane-background heat. `color` is the
  // counter's overlay color; `max` the global peak for normalization.
  setLaneCounter(
    begin: number,
    bucketUs: number,
    buckets: number,
    byPid: Map<string, number[]>,
    color: string,
    max: number,
  ): void {
    this.laneCounter = { begin, bucketUs, buckets, byPid, max, ramp: this.buildRamp(color) };
    this.invalidate();
  }

  clearLaneCounter(): void {
    this.laneCounter = null;
    this.invalidate();
  }

  // Stacked per-node system components (e.g. cpu user/system/iowait, in percent
  // of the row height) rendered on each host row.
  setNodeCounters(
    begin: number,
    bucketUs: number,
    buckets: number,
    byHost: Map<string, { key: string; values: number[]; counts?: number[]; color: string }[]>,
    scale: number,
  ): void {
    this.nodeCounters = { begin, bucketUs, buckets, byHost, scale };
    if (this.nodeStripBoost !== 1) {
      this.nodeStripBoost = 1;
      this.layoutLanes();
    }
    this.invalidate();
  }

  clearNodeCounters(): void {
    this.nodeCounters = null;
    if (this.nodeStripBoost !== 0) {
      this.nodeStripBoost = 0;
      this.layoutLanes();
    }
    this.invalidate();
  }

  // Visible bucket window for a bucketed series (x monotonic in the index).
  private bucketRange(begin: number, bucketUs: number, n: number): { lo: number; hi: number } {
    const xb = (i: number) => this.xOf(begin + (i + 0.5) * bucketUs);
    let lo = 0;
    for (let b = n - 1; lo < b;) {
      const m = (lo + b) >> 1;
      if (xb(m) < GUTTER - 4) lo = m + 1;
      else b = m;
    }
    let hi = n - 1;
    for (let a = 0; a < hi;) {
      const m = (a + hi + 1) >> 1;
      if (xb(m) > this.cssW + 4) hi = m - 1;
      else a = m;
    }
    return { lo: Math.max(0, lo - 1), hi: Math.min(n - 1, hi + 1) };
  }

  setNodeStripLabel(label: string | null): void {
    this.nodeStripLabel = label;
    this.invalidate();
  }

  private renderNodeStripBadges(ctx: CanvasRenderingContext2D): void {
    this.nodeStripBadges = [];
    const label = this.nodeStripLabel;
    if (label == null) return;
    ctx.save();
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    const bw = ctx.measureText(label).width + 12;
    const bh = 13;
    for (const lane of this.lanes) {
      if (lane.kind !== "host") continue;
      const y = RULER_H - this.scrollY + lane.y;
      const h = lane.rows * ROW_H;
      if (y + h < RULER_H || y > this.cssH) continue;
      const bx = GUTTER + 6;
      const by = y + (h - bh) / 2;
      ctx.fillStyle = this.th.panelBg;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.th.divider;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      ctx.fillStyle = this.th.counterLabel;
      ctx.fillText(label, bx + 6, by + bh / 2 + 0.5);
      this.nodeStripBadges.push({ x: bx, y: by, w: bw, h: bh });
    }
    ctx.restore();
  }

  private nodeStripBadgeAt(x: number, y: number): boolean {
    for (const b of this.nodeStripBadges) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
    }
    return false;
  }

  private renderNodeCounters(ctx: CanvasRenderingContext2D): void {
    const nc = this.nodeCounters;
    if (!nc) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER_H, this.cssW - GUTTER, this.cssH - RULER_H);
    ctx.clip();
    const n = nc.buckets;
    const { lo, hi } = this.bucketRange(nc.begin, nc.bucketUs, n);
    const fallbackW = this.plotW() / Math.max(n, 1);
    const xb = (i: number) => this.xOf(nc.begin + (i + 0.5) * nc.bucketUs);
    for (const lane of this.lanes) {
      if (lane.kind !== "host") continue;
      const comps = nc.byHost.get(lane.host);
      if (!comps) continue;
      const y = RULER_H - this.scrollY + lane.y;
      const h = lane.rows * ROW_H;
      if (y + h < RULER_H || y > this.cssH) continue;
      let x0 = xb(lo);
      for (let i = lo; i <= hi; i++) {
        const x1 = i + 1 <= hi ? xb(i + 1) : x0 + fallbackW;
        const rx = Math.max(x0, GUTTER);
        const rw = Math.max(1, Math.min(x1, this.cssW) - rx);
        let cum = 0;
        for (const c of comps) {
          const v = c.values[i] * nc.scale;
          if (v <= 0) continue;
          // Floor tiny values so a nonzero bucket is always visible/aimable.
          let ch = Math.max((Math.min(v, 100) / 100) * h, 1.5);
          ch = Math.min(ch, h - cum);
          if (ch <= 0) break;
          ctx.fillStyle = c.color;
          ctx.fillRect(rx, y + h - cum - ch, rw, ch);
          cum += ch;
        }
        x0 = x1;
      }
      const hov = this.nodeStripHoverAt;
      if (hov && hov.host === lane.host) {
        const hx0 = xb(hov.i);
        const hx1 = hov.i + 1 < n ? xb(hov.i + 1) : hx0 + fallbackW;
        ctx.strokeStyle = this.th.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.max(hx0, GUTTER) + 0.5, y + 0.5, Math.max(hx1 - hx0, 6), h - 1);
      }
    }
    ctx.restore();
  }

  // Strip bucket under the cursor: the whole host band is the hit target.
  private nodeStripAt(
    x: number,
    y: number,
  ): {
    host: string;
    comps: { key: string; values: number[]; counts?: number[]; color: string }[];
    i: number;
  } | null {
    const nc = this.nodeCounters;
    if (!nc || x < GUTTER || y < RULER_H) return null;
    for (const lane of this.lanes) {
      if (lane.kind !== "host") continue;
      const ly = RULER_H - this.scrollY + lane.y;
      const h = lane.rows * ROW_H;
      if (y < ly || y > ly + h) continue;
      const comps = nc.byHost.get(lane.host);
      if (!comps) return null;
      const rt = this.toReal(this.timeOf(x));
      let i = Math.floor((rt - nc.begin) / nc.bucketUs);
      if (i < 0 || i >= nc.buckets) return null;
      // Snap to the nearest bucket with data (within ~6px) so hitting a thin
      // spike does not require pixel-precise aim.
      const hasData = (idx: number) =>
        idx >= 0 && idx < nc.buckets && comps.some((c) => (c.values[idx] ?? 0) > 0);
      if (!hasData(i)) {
        const px = Math.abs(
          this.xOf(nc.begin + 1.5 * nc.bucketUs) - this.xOf(nc.begin + 0.5 * nc.bucketUs),
        );
        const radius = Math.max(1, Math.min(12, Math.ceil(6 / Math.max(px, 0.5))));
        for (let j = 1; j <= radius; j++) {
          if (hasData(i - j)) {
            i -= j;
            break;
          }
          if (hasData(i + j)) {
            i += j;
            break;
          }
        }
      }
      return { host: lane.host, comps, i };
    }
    return null;
  }

  // Clicking the strip selects a synthetic ph="C" reading (host + component
  // values at that bucket) so the regular event sidebar can inspect counters.
  private nodeStripEventAt(x: number, y: number): TraceEvent | null {
    const nc = this.nodeCounters;
    const s = this.nodeStripAt(x, y);
    if (!nc || !s) return null;
    const args: Record<string, unknown> = { host: s.host };
    for (const c of s.comps) args[c.key] = c.values[s.i] ?? 0;
    // Coarse buckets fold several raw emissions; say so instead of presenting
    // an average as a single reading.
    const n = s.comps[0]?.counts?.[s.i] ?? 0;
    if (n > 1) args.samples = n;
    return {
      name: this.nodeStripLabel ?? "counter",
      cat: "system",
      pid: s.host,
      tid: "",
      ts: nc.begin + s.i * nc.bucketUs,
      dur: nc.bucketUs,
      ph: "C",
      args,
    };
  }

  // Sequential single-hue ramp: panel background (empty) -> the counter color.
  private buildRamp(color: string): string[] {
    const bg = hexRgb(this.th.panelBg);
    const c = hexRgb(color);
    const out: string[] = [];
    for (let i = 0; i < LANE_RAMP_STEPS; i++) {
      const t = i / (LANE_RAMP_STEPS - 1);
      const r = Math.round(bg[0] + (c[0] - bg[0]) * t);
      const g = Math.round(bg[1] + (c[1] - bg[1]) * t);
      const b = Math.round(bg[2] + (c[2] - bg[2]) * t);
      out.push(`rgb(${r},${g},${b})`);
    }
    return out;
  }

  // Background heat behind each process lane: per-bucket cell tinted by the
  // docked counter's value, drawn after the lane stripe and under the slices.
  private renderLaneCounters(ctx: CanvasRenderingContext2D): void {
    const lc = this.laneCounter;
    if (!lc || lc.max <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER_H, this.cssW - GUTTER, this.cssH - RULER_H);
    ctx.clip();
    const n = lc.buckets;
    const xb = (i: number) => this.xOf(lc.begin + (i + 0.5) * lc.bucketUs);
    const { lo, hi } = this.bucketRange(lc.begin, lc.bucketUs, n);
    const fallbackW = this.plotW() / Math.max(n, 1);
    for (const lane of this.lanes) {
      if (lane.kind === "host") continue; // per-pid data maps to proc/thread lanes
      const vals = lc.byPid.get(lane.pid);
      if (!vals) continue;
      const y = RULER_H - this.scrollY + lane.y;
      const h = lane.rows * ROW_H;
      if (y + h < RULER_H || y > this.cssH) continue;
      for (let i = lo; i <= hi; i++) {
        const v = vals[i];
        if (v <= 0) continue;
        const x0 = xb(i);
        const x1 = i + 1 < n ? xb(i + 1) : x0 + fallbackW;
        if (x1 < GUTTER || x0 > this.cssW) continue;
        const step = clamp(
          Math.round(Math.sqrt(v / lc.max) * (LANE_RAMP_STEPS - 1)),
          0,
          LANE_RAMP_STEPS - 1,
        );
        ctx.fillStyle = lc.ramp[step];
        const rx = Math.max(x0, GUTTER);
        ctx.fillRect(rx, y, Math.max(1, Math.min(x1, this.cssW) - rx), h);
      }
    }
    ctx.restore();
  }

  private renderCounters(): void {
    const ctx = this.counterCtx;
    if (!ctx) return;
    const h = this.counterH;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.counterW, h);
    ctx.fillStyle = this.th.plotBg;
    ctx.fillRect(0, 0, this.counterW, h);

    const d = this.counters;
    const span = this.live.end - this.live.begin;
    if (d && d.bucketUs > 0 && span > 0) {
      const perSec = 1e6 / d.bucketUs;
      const plotH = h - 4;
      ctx.save();
      ctx.beginPath();
      ctx.rect(GUTTER, 0, this.counterW - GUTTER, h);
      ctx.clip();
      // Smoothed stacked areas: draw read+write total first, then read over it,
      // so [baseline, readTop] reads teal and [readTop, totalTop] reads amber.
      const pts: { x: number; rt: number; tt: number }[] = [];
      for (let i = 0; i < d.read.length; i++) {
        const tc = d.begin + (i + 0.5) * d.bucketUs;
        const x = this.xOf(tc);
        if (x < GUTTER - 4 || x > this.counterW + 4) continue;
        const rh = ((d.read[i] * perSec) / this.counterPeak) * plotH;
        const wh = ((d.write[i] * perSec) / this.counterPeak) * plotH;
        pts.push({ x, rt: h - rh, tt: h - rh - wh });
      }
      const area = (topOf: (p: { x: number; rt: number; tt: number }) => number, color: string) => {
        if (pts.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, h);
        ctx.lineTo(pts[0].x, topOf(pts[0]));
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (topOf(pts[i]) + topOf(pts[i + 1])) / 2;
          ctx.quadraticCurveTo(pts[i].x, topOf(pts[i]), mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, topOf(last));
        ctx.lineTo(last.x, h);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      area((p) => p.tt, this.th.write);
      area((p) => p.rt, this.th.read);
      ctx.restore();
    }

    ctx.fillStyle = this.th.plotBg;
    ctx.fillRect(0, 0, GUTTER, h);
    ctx.strokeStyle = this.th.divider;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 0.5, 0);
    ctx.lineTo(GUTTER - 0.5, h);
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(this.counterW, h - 0.5);
    ctx.stroke();
    ctx.fillStyle = this.th.counterLabel;
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillText("I/O BANDWIDTH", 8, 4);
    ctx.fillStyle = this.th.laneText;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.fillText(formatBytesPerSec(this.counterPeak), GUTTER - 8, 5);
    ctx.textAlign = "left";
    const ly = h - 6;
    ctx.fillStyle = this.th.read;
    ctx.fillRect(8, ly - 4, 8, 8);
    ctx.fillStyle = this.th.write;
    ctx.fillRect(58, ly - 4, 8, 8);
    ctx.fillStyle = this.th.laneText;
    ctx.textBaseline = "middle";
    ctx.fillText("read", 20, ly);
    ctx.fillText("write", 70, ly);
    ctx.restore();
  }

  // Render-on-demand: a frame is only scheduled while something is animating
  // (easing, held keys, pending zoom) or after an explicit invalidate(). When
  // idle, no rAF runs at all, so the app uses ~0 CPU.
  private requestFrame(): void {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  private invalidate(): void {
    this._dirty = true;
    this.requestFrame();
  }

  private frame = (): void => {
    this.frameScheduled = false;
    this.applyKeys();
    // Apply at most one clamped zoom step per frame; carry the remainder so a
    // large momentum burst spreads across frames (smooth glide, not a jump).
    if (this.pendingZoom !== 0) {
      const step = clamp(this.pendingZoom, -ZOOM_MAX_STEP, ZOOM_MAX_STEP);
      this.zoomAt(this.zoomFocusX, step);
      this.pendingZoom -= step;
      if (Math.abs(this.pendingZoom) < 1) this.pendingZoom = 0;
    }
    const span = this.live.end - this.live.begin;
    const db = this.target.begin - this.live.begin;
    const de = this.target.end - this.live.end;
    let animating = false;
    // Relative thresholds; when both edges are within tolerance the span has
    // converged too, so no separate absolute span check is needed (an absolute
    // one never settles for microsecond-scale values and spins the loop).
    if (Math.abs(db) > span * 1e-4 || Math.abs(de) > span * 1e-4) {
      this.live.begin += db * EASE;
      this.live.end += de * EASE;
      this._dirty = true;
      animating = true;
    } else if (this.live.begin !== this.target.begin || this.live.end !== this.target.end) {
      this.live.begin = this.target.begin;
      this.live.end = this.target.end;
      this._dirty = true;
    }
    if (this._dirty) {
      this.render();
      this.renderMinimap();
      this.renderCounters();
      this.cb.onFrame?.();
      this._dirty = false;
    }
    if (animating || this.keys.size > 0 || this.pendingZoom !== 0) this.requestFrame();
  };

  private render(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    ctx.fillStyle = this.th.panelBg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    this.renderLanes(ctx);
    this.renderLaneCounters(ctx);
    this.renderNodeCounters(ctx);
    this.renderGridlines(ctx);
    this.renderSlices(ctx);
    this.renderNodeStripBadges(ctx);
    this.renderSpawnArrows(ctx);
    this.renderGaps(ctx);
    this.renderBreaks(ctx);
    this.renderSelection(ctx);
    this.renderRuler(ctx);
    this.renderGutter(ctx);
    this.renderCrosshair(ctx);

    ctx.restore();
  }

  // Spawn-connector arrows for the selected process's lineage: from the parent
  // clone to the child, drawn only on selection to avoid flow-arrow clutter.
  private renderSpawnArrows(ctx: CanvasRenderingContext2D): void {
    if (this.procParent.size === 0) return;
    const laneOfPid = new Map<number, Lane>();
    for (const lane of this.lanes) {
      const p = Number(lane.pid);
      if (!laneOfPid.has(p)) laneOfPid.set(p, lane);
    }
    // Anchor at the parent lane's bottom (where it "hands off") and the child
    // lane's top (its first event), so the connector reads as parent -> child.
    const botOf = (lane: Lane) => RULER_H - this.scrollY + lane.y + lane.rows * ROW_H;
    const topOf = (lane: Lane) => RULER_H - this.scrollY + lane.y;
    const selPid = this.selected ? Number(this.selected.pid) : null;
    const inLineage = (child: number) =>
      selPid != null &&
      (child === selPid ||
        this.procParent.get(child) === selPid ||
        this.procParent.get(selPid) === child);

    const draw = (childPid: number, hot: boolean) => {
      const parent = this.procParent.get(childPid);
      const spawn = this.procSpawn.get(childPid);
      if (parent == null || parent < 0 || spawn == null || spawn <= 0) return;
      const pl = laneOfPid.get(parent);
      const cl = laneOfPid.get(childPid);
      if (!pl || !cl) return;
      const first = this.procFirst.get(childPid) ?? spawn;
      const x1 = this.xOf(spawn);
      const x2 = this.xOf(first);
      if ((x1 < GUTTER && x2 < GUTTER) || (x1 > this.cssW && x2 > this.cssW)) return;
      const y1 = botOf(pl);
      const y2 = topOf(cl);
      ctx.strokeStyle = hot ? this.th.accent : this.th.accentSoft;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = hot ? 1.5 : 1;
      // Near-vertical S: drop straight from the fork, ease into the child start.
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, (y1 + y2) / 2, x2, (y1 + y2) / 2, x2, y2);
      ctx.stroke();
      if (hot) {
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - 4, y2 - 6);
        ctx.lineTo(x2 + 4, y2 - 6);
        ctx.closePath();
        ctx.fill();
      }
    };

    for (const [pid] of this.procParent) if (!inLineage(pid)) draw(pid, false);
    for (const [pid] of this.procParent) if (inLineage(pid)) draw(pid, true);
  }

  // Vertical cursor line plus a time readout pinned in the ruler.
  private renderCrosshair(ctx: CanvasRenderingContext2D): void {
    if (!this.cursorInside || this.dragging || this.selecting) return;
    const x = Math.round(this.mouseX) + 0.5;
    ctx.strokeStyle = this.th.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, this.cssH);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = formatTime(this.toReal(this.timeOf(this.mouseX)));
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const tw = ctx.measureText(label).width + 8;
    const lx = clamp(this.mouseX - tw / 2, GUTTER, this.cssW - tw);
    ctx.fillStyle = this.th.groupText;
    ctx.fillRect(lx, RULER_H - 15, tw, 14);
    ctx.fillStyle = this.th.plotBg;
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 4, RULER_H - 8);
  }

  // Hatched markers at each compressed idle gap, labeled with the real time
  // skipped, so the discontinuous axis is never silent.
  private renderBreaks(ctx: CanvasRenderingContext2D): void {
    if (!this.timelapse) return;
    for (const g of this.runGaps) {
      const x0 = this.xdOf(this.toDisplay(g.begin));
      const x1 = this.xdOf(this.toDisplay(g.end));
      if (x1 < GUTTER || x0 > this.cssW) continue;
      const cx0 = Math.max(GUTTER, x0);
      const cx1 = Math.min(this.cssW, x1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx0, RULER_H, Math.max(1, cx1 - cx0), this.cssH - RULER_H);
      ctx.clip();
      ctx.strokeStyle = this.th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = cx0 - this.cssH; x < cx1 + this.cssH; x += 6) {
        ctx.moveTo(x, this.cssH);
        ctx.lineTo(x + this.cssH, RULER_H);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = this.th.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(cx0 + 0.5, RULER_H);
      ctx.lineTo(cx0 + 0.5, this.cssH);
      ctx.moveTo(cx1 - 0.5, RULER_H);
      ctx.lineTo(cx1 - 0.5, this.cssH);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `skip ${formatTime(g.end - g.begin)}`;
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width + 8;
      const mid = clamp((cx0 + cx1) / 2, GUTTER + tw / 2, this.cssW - tw / 2);
      ctx.fillStyle = this.th.plotBg;
      ctx.fillRect(mid - tw / 2, RULER_H + 2, tw, 13);
      ctx.strokeStyle = this.th.accent;
      ctx.strokeRect(mid - tw / 2 + 0.5, RULER_H + 2.5, tw - 1, 12);
      ctx.fillStyle = this.th.accent;
      ctx.textAlign = "center";
      ctx.fillText(label, mid, RULER_H + 9);
      ctx.textAlign = "left";
    }
  }

  // Tick positions shared by the gridlines and the ruler labels.
  private timeTicks(): { step: number; first: number } {
    const span = this.live.end - this.live.begin;
    const step = niceStep((span / this.plotW()) * 90);
    const first = Math.ceil(this.live.begin / step) * step;
    return { step, first };
  }

  // Vertical time gridlines, drawn BEHIND the slices so event blocks sit in
  // front of them (like Perfetto).
  private renderGridlines(ctx: CanvasRenderingContext2D): void {
    const span = this.live.end - this.live.begin;
    const pw = this.plotW();
    const { step, first } = this.timeTicks();
    ctx.strokeStyle = this.th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = first; t <= this.live.end; t += step) {
      const x = Math.round(GUTTER + ((t - this.live.begin) / span) * pw) + 0.5;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, this.cssH);
    }
    ctx.stroke();
  }

  private renderSelection(ctx: CanvasRenderingContext2D): void {
    if (!this.selection) return;
    const span = this.live.end - this.live.begin;
    const pw = this.plotW();
    const x0 = clamp(
      GUTTER + ((this.selection.t0 - this.live.begin) / span) * pw,
      GUTTER,
      this.cssW,
    );
    const x1 = clamp(
      GUTTER + ((this.selection.t1 - this.live.begin) / span) * pw,
      GUTTER,
      this.cssW,
    );
    ctx.fillStyle = this.th.selFill;
    ctx.fillRect(x0, RULER_H, x1 - x0, this.cssH - RULER_H);
    ctx.strokeStyle = this.th.selStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, RULER_H);
    ctx.lineTo(x0 + 0.5, this.cssH);
    ctx.moveTo(x1 - 0.5, RULER_H);
    ctx.lineTo(x1 - 0.5, this.cssH);
    ctx.stroke();

    const rt0 = this.toReal(this.selection.t0);
    const rt1 = this.toReal(this.selection.t1);
    const dur = rt1 - rt0;
    const bw = this.selBandwidth(rt0, rt1);
    const main = `${formatTime(rt0)} → ${formatTime(rt1)}` + `   ·   Δ ${formatTime(dur)}`;
    const bwStr = bw > 0 ? `   ·   ${formatBytesPerSec(bw)}` : "";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    const pad = 8;
    const mw = ctx.measureText(main).width;
    const bwW = ctx.measureText(bwStr).width;
    const tw = mw + bwW + pad * 2;
    const lx = clamp((x0 + x1) / 2 - tw / 2, GUTTER, this.cssW - tw);
    const ty = RULER_H + 3;
    ctx.fillStyle = this.th.plotBg;
    ctx.fillRect(lx, ty, tw, 17);
    ctx.strokeStyle = this.th.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx + 0.5, ty + 0.5, tw - 1, 16);
    ctx.fillStyle = this.th.numText;
    ctx.fillText(main, lx + pad, ty + 9);
    ctx.fillStyle = this.th.accent;
    ctx.fillText(bwStr, lx + pad + mw, ty + 9);
  }

  // Total read+write bytes in [t0, t1] over the wall time, as bytes/sec.
  private selBandwidth(t0: number, t1: number): number {
    const c = this.counters;
    if (!c || !c.bucketUs || t1 <= t0) return 0;
    let bytes = 0;
    const n = Math.min(c.read.length, c.write.length);
    for (let i = 0; i < n; i++) {
      const bs = c.begin + i * c.bucketUs;
      const be = bs + c.bucketUs;
      if (be <= t0 || bs >= t1) continue;
      const ov = (Math.min(be, t1) - Math.max(bs, t0)) / c.bucketUs;
      bytes += ((c.read[i] || 0) + (c.write[i] || 0)) * ov;
    }
    return bytes / ((t1 - t0) / 1e6);
  }

  private renderLanes(ctx: CanvasRenderingContext2D): void {
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      const y = RULER_H - this.scrollY + lane.y;
      const h = lane.rows * ROW_H;
      if (y + h < RULER_H || y > this.cssH) continue;
      ctx.fillStyle = i % 2 === 0 ? this.th.laneAlt : this.th.panelBg;
      ctx.fillRect(0, y, this.cssW, h);
    }
  }

  private renderSlices(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER_H, this.cssW - GUTTER, this.cssH - RULER_H);
    ctx.clip();

    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";

    for (const s of this.slices) {
      const sx = this.xOf(s.ts);
      const sw = Math.max(this.xOf(s.ts + s.dur) - sx, 1);
      if (sx + sw < GUTTER || sx > this.cssW) continue;
      const lane = this.lanes[s.laneIdx];
      const sy = RULER_H - this.scrollY + lane.y + s.depth * ROW_H;
      if (sy + ROW_H < RULER_H || sy > this.cssH) continue;

      const fill = this.metricFill(s) ?? colorFor(sliceKey(s.ev));
      const x = Math.max(sx, GUTTER);
      const w = Math.min(sx + sw, this.cssW) - x;
      // When searching, dim non-matching slices so matches stand out.
      const dim = this.searchTerm !== "" && !this.searchMatchSet.has(s);
      if (s.density) {
        // Aggregated block: inset and dimmed so a run of them reads as a
        // "density" strip distinct from individual slices.
        ctx.globalAlpha = dim ? 0.12 : 0.55;
        ctx.fillStyle = fill;
        ctx.fillRect(x, sy + 3, w, ROW_H - 6);
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = dim ? 0.15 : 1;
        ctx.fillStyle = fill;
        ctx.fillRect(x, sy + 1, w, ROW_H - 2);
        ctx.globalAlpha = 1;
      }

      if (s === this.hovered) {
        ctx.strokeStyle = this.th.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, sy + 1.5, w - 1, ROW_H - 3);
      }
      if (s.ev === this.selected) {
        ctx.strokeStyle = this.th.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, sy + 2, w - 2, ROW_H - 4);
      }

      if (!s.density && sw > 32) {
        ctx.fillStyle = contrastText(fill);
        const label = String(s.ev.name ?? "");
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, sy, w - 4, ROW_H);
        ctx.clip();
        ctx.fillText(label, x + 4, sy + ROW_H / 2);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  private renderRuler(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = this.th.plotBg;
    ctx.fillRect(0, 0, this.cssW, RULER_H);
    ctx.strokeStyle = this.th.divider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(this.cssW, RULER_H - 0.5);
    ctx.stroke();

    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = this.th.ruler;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText("TRACK", 12, RULER_H / 2);
    ctx.fillText("I/O UTIL", COL_UTIL, RULER_H / 2);
    ctx.textAlign = "right";
    ctx.fillText("OPS", COL_OPS, RULER_H / 2);
    ctx.fillText("BYTES", COL_BYTES, RULER_H / 2);
    ctx.textAlign = "left";

    const span = this.live.end - this.live.begin;
    const pw = this.plotW();
    const { step, first } = this.timeTicks();
    ctx.fillStyle = this.th.laneText;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let t = first; t <= this.live.end; t += step) {
      const x = GUTTER + ((t - this.live.begin) / span) * pw;
      // Short tick mark in the header; the full-height line is a background
      // gridline drawn behind the slices.
      ctx.strokeStyle = this.th.divider;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 6);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTick(this.toReal(t), step), x + 3, RULER_H / 2);
    }
  }

  private renderGutter(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = this.th.plotBg;
    ctx.fillRect(0, RULER_H, GUTTER, this.cssH - RULER_H);
    ctx.strokeStyle = this.th.divider;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 0.5, 0);
    ctx.lineTo(GUTTER - 0.5, this.cssH);
    ctx.stroke();

    for (const lane of this.lanes) {
      const y = RULER_H - this.scrollY + lane.y;
      const h = lane.rows * ROW_H;
      const top = Math.max(y, RULER_H);
      const bottom = Math.min(y + h, this.cssH);
      if (bottom <= RULER_H || top >= this.cssH) continue;
      const cy = clamp(y + ROW_H / 2, RULER_H + ROW_H / 2, this.cssH - 2);

      if (lane.kind === "host") {
        ctx.fillStyle = this.th.groupBand;
        ctx.fillRect(0, top, GUTTER - 1, bottom - top);
      }

      const collapsed = this.collapsed.has(lane.collapseKey);
      if (lane.collapsible) {
        ctx.fillStyle = this.th.ruler;
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(collapsed ? ">" : "v", lane.indent + 2, cy);
      }
      if (lane.kind === "proc") {
        ctx.fillStyle = colorFor("proc:" + lane.pid);
        ctx.fillRect(lane.indent + TWIST_W - 2, top, 2, bottom - top);
      }

      const labelX = lane.indent + TWIST_W + (lane.kind === "thread" ? 2 : 4);
      ctx.save();
      ctx.beginPath();
      ctx.rect(labelX, top, COL_UTIL - labelX - 8, bottom - top);
      ctx.clip();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      if (lane.kind === "host") {
        ctx.fillStyle = this.th.groupText;
        ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      } else if (lane.kind === "proc") {
        ctx.fillStyle = this.th.laneText;
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      } else {
        ctx.fillStyle = this.th.numText;
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      }
      ctx.fillText(lane.label, labelX, cy);
      ctx.restore();

      if (lane.kind !== "thread") this.renderLaneColumns(ctx, lane, cy);
    }
  }

  private renderLaneColumns(ctx: CanvasRenderingContext2D, lane: Lane, cy: number): void {
    const wallUs = this.totalSpan || 1;
    const wallSec = wallUs / 1e6;
    let ops = 0;
    let bytes = 0;
    const add = (p: number) => {
      ops += this.ovOpsByPid.get(p) ?? 0;
      bytes += this.bytesByPid.get(p) ?? 0;
    };
    // Per-process I/O util; a host row averages its processes and reports the
    // spread (stdev) so cross-rank I/O imbalance is visible.
    let util = 0;
    let utilSd = 0;
    if (lane.kind === "host") {
      const utils: number[] = [];
      for (const p of this.hostPids.get(lane.host) ?? []) {
        add(p);
        utils.push(clamp((this.ioBusyByPid.get(p) ?? 0) / wallUs, 0, 1));
      }
      if (utils.length) {
        util = utils.reduce((a, b) => a + b, 0) / utils.length;
        utilSd = Math.sqrt(utils.reduce((a, b) => a + (b - util) ** 2, 0) / utils.length);
      }
    } else {
      const pid = Number(lane.pid);
      add(pid);
      util = clamp((this.ioBusyByPid.get(pid) ?? 0) / wallUs, 0, 1);
    }

    const bh = 6;
    ctx.fillStyle = this.th.divider;
    ctx.fillRect(COL_UTIL, cy - bh / 2, COL_UTIL_W, bh);
    ctx.fillStyle = util > 0.8 ? this.th.gapStroke : this.th.accent;
    ctx.fillRect(COL_UTIL, cy - bh / 2, COL_UTIL_W * util, bh);
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = this.th.numText;
    const utilText =
      lane.kind === "host"
        ? `${Math.round(util * 100)}%±${Math.round(utilSd * 100)}%`
        : `${Math.round(util * 100)}%`;
    ctx.fillText(utilText, COL_UTIL + COL_UTIL_W + 5, cy);
    ctx.textAlign = "right";
    ctx.fillText(formatRate(ops / wallSec), COL_OPS, cy);
    if (bytes > 0) {
      ctx.fillText(formatBytesCompact(bytes), COL_BYTES, cy);
    } else {
      ctx.fillStyle = this.th.ruler;
      ctx.fillText("-", COL_BYTES, cy);
    }
    ctx.textAlign = "left";
  }

  // The collapsible gutter row under a gutter click, or null.
  private gutterRowAt(y: number): Lane | null {
    for (const lane of this.lanes) {
      if (!lane.collapsible) continue;
      const ly = RULER_H - this.scrollY + lane.y;
      if (y >= ly && y <= ly + ROW_H) return lane;
    }
    return null;
  }
}
