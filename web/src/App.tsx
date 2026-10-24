import { createEffect, createMemo, createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Rail, type TraceView } from "./ui/Rail";
import { ProvenanceView } from "./prov/ProvenanceView";
import { LogConsole } from "./ui/LogConsole";
import { StatusBar } from "./ui/StatusBar";
import Analysis from "./analysis/Analysis";
import { PanelEmbed } from "./ui/PanelCards";
import { RangeFilter } from "./ui/RangeFilter";
import { DashGrid, createDashboard, type DashLayout, type DashState } from "./ui/dashgrid";
import {
  fetchCallTree,
  fetchHistogram,
  fetchInfo,
  fetchRuns,
  openRunsStream,
  type RunInfo,
  fetchLayers,
  fetchOverviewDensity,
  fetchProcTree,
  fetchTimelineStream,
  fetchViz,
  fetchVizCounters,
  fetchVizBreaks,
  fetchVizStats,
  apiUrl,
  clearRunScope,
  currentRunScope,
  SINGLE_FILE,
} from "./data/api";
import { calleesTree, callersTree, functionList } from "./flame/sandwich";
import type {
  DensityBlock,
  FlameNode,
  HistogramResponse,
  InfoResponse,
  SelectionStats,
  TraceEvent,
  VizMetadata,
} from "./data/types";
import { CONFIG } from "./data/config";
import { onHostMessage, post } from "./data/vscode";
import { Timeline, GUTTER, type Gap } from "./timeline/timeline";
import { CounterOverlay } from "./timeline/CounterOverlay";
import { TraceSourceContext } from "./data/source";
import { createHttpSource } from "./data/httpSource";
import { ApiExplorer } from "./api/ApiExplorer";
import { Flamegraph } from "./flame/flamegraph";
import { SandwichView } from "./flame/SandwichView";
import { FlameTooltip, type FlameHover } from "./flame/FlameTooltip";

// In the VS Code webview with no server yet: show the load screen instead of
// booting the (empty) timeline.
const NEEDS_LOAD = CONFIG.vscode && !CONFIG.apiBase;
import { colorFor, sliceKey } from "./timeline/color";
import { formatBytes, formatBytesPerSec, formatCounterValue, formatTime } from "./timeline/format";

interface HoverState {
  ev: TraceEvent;
  x: number;
  y: number;
}

interface CatStat {
  name: string;
  count: number;
}

// Overview card catalog: id -> {label, kind, default size}. `kind:"solid"` cards
// render from App signals; `kind:"panel"` cards are Panel-embedded pcard slots.
// The drag-resize editor places them on a 6-column grid ({x,y,w,h}).
interface OvCard {
  label: string;
  kind: "solid" | "panel";
  w: number;
  h: number;
}
const OV_CATALOG: Record<string, OvCard> = {
  top_events: { label: "Top event types", kind: "solid", w: 4, h: 2 },
  idle: { label: "Idle between runs", kind: "solid", w: 2, h: 2 },
  bandwidth: { label: "I/O bandwidth", kind: "panel", w: 3, h: 2 },
  latency: { label: "Operation latency", kind: "panel", w: 2, h: 2 },
  xfer_hist: { label: "Transfer sizes", kind: "panel", w: 2, h: 2 },
  access_pattern: { label: "Access pattern", kind: "panel", w: 2, h: 1 },
  op_time: { label: "I/O time by operation", kind: "panel", w: 2, h: 2 },
  op_counts: { label: "Operation counts", kind: "panel", w: 2, h: 2 },
  read_write: { label: "Read vs write", kind: "panel", w: 2, h: 1 },
  avg_xfer: { label: "Avg transfer size", kind: "panel", w: 2, h: 1 },
  data_meta: { label: "Data vs metadata", kind: "panel", w: 2, h: 1 },
  bw_by_host: { label: "Bandwidth by host", kind: "panel", w: 2, h: 2 },
  io_summary: { label: "I/O by host", kind: "panel", w: 2, h: 2 },
  busiest: { label: "Busiest processes", kind: "panel", w: 2, h: 3 },
  runs: { label: "Runs", kind: "solid", w: 6, h: 2 },
};
const OV_CATALOG_IDS = Object.keys(OV_CATALOG);
// Newest runs first, and only what fits without scrolling for a first glance.
const OV_RUNS_ROWS = 6;
const OV_PANEL_IDS = OV_CATALOG_IDS.filter((id) => OV_CATALOG[id].kind === "panel");
const OV_DEFAULT_LAYOUT: DashLayout = {
  runs: { x: 1, y: 1, w: 6, h: 1 },
  top_events: { x: 1, y: 2, w: 4, h: 2 },
  idle: { x: 5, y: 2, w: 2, h: 2 },
  bandwidth: { x: 1, y: 4, w: 3, h: 2 },
  latency: { x: 4, y: 4, w: 3, h: 2 },
  op_time: { x: 1, y: 6, w: 2, h: 2 },
  op_counts: { x: 3, y: 6, w: 2, h: 2 },
  busiest: { x: 5, y: 6, w: 2, h: 3 },
  data_meta: { x: 1, y: 8, w: 2, h: 1 },
  read_write: { x: 3, y: 8, w: 2, h: 1 },
  avg_xfer: { x: 1, y: 9, w: 2, h: 1 },
  bw_by_host: { x: 3, y: 9, w: 2, h: 1 },
  io_summary: { x: 5, y: 9, w: 2, h: 2 },
  xfer_hist: { x: 1, y: 10, w: 2, h: 2 },
  access_pattern: { x: 3, y: 10, w: 2, h: 1 },

};
const OV_DEFAULT: DashState = { cards: OV_CATALOG_IDS, layout: OV_DEFAULT_LAYOUT };
const OV_LS_KEY = "dfd.dash.overview";

type AnGroup = "name" | "file" | "pid" | "cat" | null;
const BOTTOM_TABS: [string, string, AnGroup][] = [
  ["summary", "summary", "name"],
  ["bottlenecks", "bottlenecks", "name"],
  ["bottomup", "bottom-up", "name"],
  ["calltree", "call tree", null],
  ["ranks", "ranks", "pid"],
  ["files", "files", "file"],
  ["eventlog", "event log", null],
];

const METRIC_HELP: Record<string, string> = {
  "wall time": "Elapsed time from the first to the last event in the trace.",
  "total i/o": "Total bytes read + written across all POSIX/STDIO/IO operations.",
  "i/o share": "Share of total event time spent in I/O (POSIX/STDIO/IO) categories.",
  processes: "Number of distinct processes (pids) in the trace.",
  files: "Distinct files the trace declared (FH metadata records).",
  "i/o files": "Distinct files actually read from or written to (a subset of files).",
  "i/o util":
    "Fraction of wall time a process spent in I/O operations. Host rows show mean +/- stdev across their processes.",
  ops: "Operations per second (traced events) for the process.",
  bytes: "Total bytes read + written by the process.",
  track: "Node -> process (fork tree) -> thread. Click a row to collapse/expand.",
  operation: "The traced operation (function or syscall) name.",
  layer: "I/O layer / category the operation belongs to (POSIX, MPI-IO, ...).",
  total: "Total inclusive time spent in this operation across the scope.",
  "wall share": "This operation's total time as a share of the scope's wall time.",
  self: "Time spent in this operation excluding nested child operations.",
  start: "Offset from the trace start when this event began.",
  duration: "Wall-clock time this event took.",
  size: "Bytes transferred by this I/O operation (args.ret / size).",
  bandwidth: "Bytes transferred divided by the event duration.",
  offset: "File offset of this I/O operation (hex).",
  fd: "File descriptor the operation acted on.",
  busy: "Total time of the events merged into this block.",
  events: "Number of individual events merged into this block.",
  host: "Node the process ran on (resolved from HH metadata).",
  file: "File path (resolved from FH metadata).",
  "pid/tid": "Process id / thread id.",
};

const THEME_KEY = "dftracer:theme";

// Saved choice if the user has toggled before, else the OS preference.
function initialTheme(): "dark" | "light" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* localStorage may be unavailable */
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

// Real name -> category from /viz/layers; empty until it loads.
let LAYER_MAP: Record<string, string> = {};

// Heuristic fallback for names the summary never saw.
function layerOf(name: string): string {
  const real = LAYER_MAP[name];
  if (real) return real;
  if (/^MPI_/.test(name)) return "MPI-IO";
  if (/^(fopen|fread|fwrite|fclose|fseek|fgets|fputs|fprintf)/.test(name)) return "STDIO";
  if (
    /^(open|read|write|pread|pwrite|lseek|close|fsync|fdatasync|stat|opendir|readdir|mkdir|unlink|access|dup|fcntl|creat|truncate)/.test(
      name,
    ) ||
    /^__[a-z]*stat/.test(name) ||
    /64$/.test(name)
  )
    return "POSIX";
  return "app";
}

// Drag-resize with a full-viewport capture overlay: the overlay swallows
// pointer events so components under the cursor don't fire hover changes or
// select text (the flicker), and updates are throttled to one per frame.
function beginDragResize(e: MouseEvent, apply: (dy: number) => void): void {
  e.preventDefault();
  const startY = e.clientY;
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;cursor:row-resize;user-select:none";
  document.body.appendChild(overlay);
  let raf = 0;
  let dy = 0;
  const move = (ev: MouseEvent) => {
    dy = ev.clientY - startY;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply(dy);
      });
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (raf) cancelAnimationFrame(raf);
    overlay.remove();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

export default function App() {
  const source = createHttpSource();
  let canvas!: HTMLCanvasElement;
  let minimap!: HTMLCanvasElement;
  let counterCanvas!: HTMLCanvasElement;
  let flameCanvas!: HTMLCanvasElement;
  let flame: Flamegraph | undefined;
  let flameInflight: AbortController | undefined;
  let flameLoadedQuery: string | null = null;
  let bottomFlame: Flamegraph | undefined;
  let timeline: Timeline | undefined;
  let inflight: AbortController | undefined;
  let counterInflight: AbortController | undefined;
  let overviewInflight: AbortController | undefined;
  // Cache the minimap overview per query so toggling a filter doesn't re-scan.
  const overviewCache = new Map<string, DensityBlock[]>();

  const [info, setInfo] = createSignal<InfoResponse | null>(null);
  const [runs, setRuns] = createSignal<RunInfo[]>([]);
  const [runsFeed, setRunsFeed] = createSignal<"off" | "live">("off");
  const [watchMode, setWatchMode] = createSignal<"poll" | "events">("poll");
  let runsSeq = -1;
  let stopRuns: (() => void) | null = null;
  // The first runs frame beats /api/info on every load, so a page can be open
  // when the first records land. It then runs the trace load in place.
  let recovering = false;
  let refreshing = false;
  let refreshedAt = 0;
  const activeRun = () => new URLSearchParams(location.search).get("run") || "";

  // A tree can hold hundreds of runs, so the bar pins only the ones worth
  // clicking and the rest move behind a filterable list.
  const RUN_PIN_FINISHED = 2;
  const RUN_LIST_MAX = 300;
  const [runPicker, setRunPicker] = createSignal(false);
  const [runFilter, setRunFilter] = createSignal("");
  const pinnedRuns = () => {
    const all = runs();
    const live = all.filter((r) => r.state === "live" || r.state === "stalled");
    const done = all.filter((r) => r.state !== "live" && r.state !== "stalled");
    const keep = new Set([...live, ...done.slice(-RUN_PIN_FINISHED)].map((r) => r.id));
    if (activeRun()) keep.add(activeRun());
    return all.filter((r) => keep.has(r.id));
  };
  const hiddenRuns = () => runs().length - pinnedRuns().length;
  const listedRuns = () => {
    const q = runFilter().trim().toLowerCase();
    const hits = q
      ? runs().filter((r) =>
          `${r.id} ${r.format} ${r.state} ${r.dir}`.toLowerCase().includes(q),
        )
      : runs();
    return hits.slice(0, RUN_LIST_MAX);
  };

  // Process tree, hosts and per-process io. Re-run when a run appears while the
  // page is open, otherwise the new pids have no host label.
  // Everything that needs /api/info, in one place: the boot and the recovery
  // path use it, so a page that opened on an empty tree fills in completely
  // instead of showing a waiting banner next to empty cards.
  async function loadTrace(i: InfoResponse): Promise<boolean> {
    const tr = i.time_range;
    const span = tr ? tr.max_timestamp_us - tr.min_timestamp_us : 0;
    if (span <= 0) {
      setError("No indexed events with a valid time range were found.");
      setLoading(false);
      return false;
    }
    setError(null);
    totalSpan = span;
    timeline?.setTotalSpan(span);
    fetchVizBreaks()
      .then((br) => {
        if (br.valid_end && br.valid_end > (br.valid_start ?? 0)) {
          timeline?.setTimingBounds(br.valid_start ?? 0, br.valid_end, br.max_life ?? 0);
        }
        setMultiRun(br.multi_run);
        setTimelapse(false); // offer the toggle, but do not collapse gaps by default
        setBreaks(br.gaps);
        timeline?.setBreaks(br.gaps, false);
      })
      .catch(() => {});
    loadOverview();
    loadLayers(true);
    void loadProcs();
    return true;
  }

  // Retry once if empty: the first request may race the summary build.
  async function loadLayers(retry: boolean): Promise<void> {
    try {
      const r = await fetchLayers();
      setFileCounts({ total: r.total_files, io: r.io_files });
      if (Object.keys(r.layers).length) {
        LAYER_MAP = r.layers;
        setLayerCats([...new Set(Object.values(r.layers))].sort());
      } else if (retry) setTimeout(() => void loadLayers(false), 1500);
    } catch {
      /* heuristic fallback */
    }
  }

  async function recoverFromWaiting(): Promise<void> {
    if (recovering) return;
    recovering = true;
    try {
      const i = await fetchInfo();
      setInfo(i);
      setLoading(false);
      await loadTrace(i);
    } catch {
      /* still empty; the next runs frame retries */
    } finally {
      recovering = false;
    }
  }

  function loadProcs(): void {
      fetchProcTree()
        .then((pt) => {
          timeline?.setProcTree(pt.nodes);
          setOvProcs(
            pt.nodes.map((n) => ({
              pid: n.pid,
              host: n.host || "",
              label: n.rank != null && n.rank !== "" ? `rank ${n.rank}` : `proc ${n.pid}`,
            })),
          );
          const hosts = new Map<number, string>();
          const bytes = new Map<number, number>();
          const ioBusy = new Map<number, number>();
          const labels = new Map<string, string>();
          const ranks = new Map<string, string>();
          for (const n of pt.nodes) {
            if (n.host) hosts.set(n.pid, n.host);
            if (n.bytes) bytes.set(n.pid, n.bytes);
            if (n.io_busy) ioBusy.set(n.pid, n.io_busy);
            const hasRank = n.rank != null && n.rank !== "";
            labels.set(String(n.pid), hasRank ? `rank ${n.rank}` : `proc ${n.pid}`);
            if (hasRank) ranks.set(String(n.pid), n.rank as string);
          }
          timeline?.setHosts(hosts);
          timeline?.setBytes(bytes);
          timeline?.setIoBusy(ioBusy);
          timeline?.setProcessLabels(labels);
          setProcRank(ranks);
          setGaps(timeline?.topGaps(15) ?? []); // relabel with resolved ranks
          loadKpis(new Set(pt.nodes.map((n) => n.pid)).size);
        })
        .catch(() => loadKpis(0));
  }

  // Refresh what the current view shows. Cheap: one info scan (cached by the
  // file set) and one window of slices.
  async function refreshWindow() {
    // A watched run changes state once per scan. Refetching on every frame
    // relayouts every lane and reads as a flicker, so at most one refresh per
    // two seconds, and never while one is still in flight.
    const now = performance.now();
    if (refreshing || now - refreshedAt < 2000) return;
    refreshing = true;
    refreshedAt = now;
    try {
      const i = await fetchInfo();
      setInfo(i);
      const tr = i.time_range;
      if (tr) {
        const span = tr.max_timestamp_us - tr.min_timestamp_us;
        if (span > 0) {
          totalSpan = span;
          timeline?.setTotalSpan(span);
        }
      }
    } catch (err) {
      // A scoped run can be wiped while the page is open; drop the scope so the
      // next frame loads the union instead of failing forever.
      if ((err as Error).message.includes("no run:") && currentRunScope()) {
        clearRunScope();
        refreshing = false;
        refreshedAt = 0;
        window.setTimeout(() => void refreshWindow(), 0);
        return;
      }
      /* the trace may be mid-write; the next frame retries */
    } finally {
      refreshing = false;
    }
    loadProcs();
    const v = tlView();
    requestData(v.begin, v.end || ovSpan());
  }

  // Follow the tail only when the user is already looking at it: a view parked
  // in the past must not move under the reader.
  function atTail(): boolean {
    const v = tlView();
    if (v.end === 0) return true;
    return v.end >= totalSpan * 0.98;
  }

  function pushRunsToTimeline(list: RunInfo[]) {
    const base = info()?.time_range?.min_timestamp_us ?? 0;
    timeline?.setRuns(
      list.map((r) => ({
        id: r.id,
        state: r.state,
        begin: Math.max(0, r.first_ts - base),
        end: Math.max(0, r.last_ts - base),
      })),
    );
  }

  function applyRuns(frame: { seq: number; runs: RunInfo[]; watch?: "poll" | "events" }): boolean {
    setRuns(frame.runs);
    if (frame.watch) setWatchMode(frame.watch);
    pushRunsToTimeline(frame.runs);
    if (frame.seq === runsSeq) return false;
    runsSeq = frame.seq;
    return true;
  }

  function selectRun(id: string) {
    const p = new URLSearchParams(location.search);
    if (id) p.set("run", id);
    else p.delete("run");
    location.search = p.toString();
  }
  const [meta, setMeta] = createSignal<VizMetadata | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const view = (): TraceView | "analysis" =>
    (searchParams.view as TraceView | "analysis") || "overview";
  const [editLayout, setEditLayout] = createSignal(false);
  const [showPicker, setShowPicker] = createSignal(false);
  // Named dashboards: server stores each by name; localStorage caches the open one.
  const readDashInit = (): { name: string; state: DashState | null } => {
    try {
      const s = localStorage.getItem(OV_LS_KEY);
      if (s) {
        const o = JSON.parse(s) as { name?: string; state?: Partial<DashState> };
        const valid =
          o.state && Array.isArray(o.state.cards) && o.state.layout ? (o.state as DashState) : null;
        return { name: o.name || "Overview", state: valid };
      }
    } catch {
      // corrupt/old entry
    }
    return { name: "Overview", state: null };
  };
  const dashInit = readDashInit();
  const [currentDash, setCurrentDash] = createSignal(dashInit.name);
  const [dashNames, setDashNames] = createSignal<string[]>([dashInit.name]);
  let dashSaveTimer: number | undefined;
  const persistDash = (s: DashState) => {
    const name = currentDash();
    try {
      localStorage.setItem(OV_LS_KEY, JSON.stringify({ name, state: s }));
    } catch {
      // ignore
    }
    clearTimeout(dashSaveTimer);
    dashSaveTimer = window.setTimeout(() => {
      fetch(apiUrl(`/api/dashboard/put/${encodeURIComponent(name)}`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s),
      }).catch(() => {});
    }, 500);
  };
  const dash = createDashboard({
    defaults: OV_DEFAULT,
    initial: dashInit.state,
    onChange: persistDash,
  });
  const loadDash = async (name: string) => {
    let state: DashState = OV_DEFAULT;
    try {
      const s = (await (
        await fetch(apiUrl(`/api/dashboard/get/${encodeURIComponent(name)}`))
      ).json()) as DashState;
      if (s && Array.isArray(s.cards) && s.layout) state = s;
    } catch {
      // server unavailable; use defaults
    }
    dash.hydrate(state);
    try {
      localStorage.setItem(OV_LS_KEY, JSON.stringify({ name, state }));
    } catch {
      // ignore
    }
  };
  onMount(async () => {
    try {
      const { names } = (await (await fetch(apiUrl("/api/dashboard/list"))).json()) as {
        names: string[];
      };
      const merged = [...new Set([...names, currentDash()])].sort();
      if (merged.length) setDashNames(merged);
    } catch {
      // keep local names
    }
    loadDash(currentDash());
  });
  const switchDash = (name: string) => {
    if (name === currentDash()) return;
    setCurrentDash(name);
    loadDash(name);
  };
  const newDash = () => {
    const name = (prompt("New dashboard name") || "").trim();
    if (!name || dashNames().includes(name)) return;
    setDashNames([...dashNames(), name].sort());
    setCurrentDash(name);
    dash.hydrate(OV_DEFAULT);
    persistDash(OV_DEFAULT);
  };
  const renameDash = () => {
    const old = currentDash();
    const name = (prompt("Rename dashboard", old) || "").trim();
    if (!name || name === old || dashNames().includes(name)) return;
    setCurrentDash(name);
    setDashNames([...dashNames().filter((n) => n !== old), name].sort());
    persistDash({ cards: dash.cards(), layout: dash.layout() });
    fetch(apiUrl(`/api/dashboard/${encodeURIComponent(old)}`), { method: "DELETE" }).catch(
      () => {},
    );
  };
  const deleteDash = () => {
    const name = currentDash();
    if (dashNames().length <= 1 || !confirm(`Delete dashboard "${name}"?`)) return;
    fetch(apiUrl(`/api/dashboard/${encodeURIComponent(name)}`), { method: "DELETE" }).catch(
      () => {},
    );
    const remaining = dashNames().filter((n) => n !== name);
    setDashNames(remaining);
    switchDash(remaining[0]);
  };
  const addOvCard = (id: string) => {
    const c = OV_CATALOG[id];
    dash.addCard(id, { x: 1, y: 1, w: c.w, h: c.h });
    setShowPicker(false);
  };
  const ovSpan = () => {
    const tr = info()?.time_range;
    return tr ? tr.max_timestamp_us - tr.min_timestamp_us : 0;
  };
  const [ovBegin, setOvBegin] = createSignal(0);
  const [ovEnd, setOvEnd] = createSignal(0);
  const [adhocQuery, setAdhocQuery] = createSignal("");
  const [layerCats, setLayerCats] = createSignal<string[]>([]);
  const [ovProcs, setOvProcs] = createSignal<{ pid: number; host: string; label: string }[]>([]);
  const [varLayer, setVarLayer] = createSignal("");
  const [varHost, setVarHost] = createSignal("");
  const [varRank, setVarRank] = createSignal("");
  const [refreshNonce, setRefreshNonce] = createSignal(0);
  const [autoRefresh, setAutoRefresh] = createSignal(0); // seconds; 0 = off
  const ovHosts = () =>
    [
      ...new Set(
        ovProcs()
          .map((p) => p.host)
          .filter(Boolean),
      ),
    ].sort();
  const composedQuery = () => {
    const c: string[] = [];
    if (varLayer()) c.push(`cat == "${varLayer()}"`);
    if (varHost()) {
      const pids = ovProcs()
        .filter((p) => p.host === varHost())
        .map((p) => p.pid);
      if (pids.length) c.push("(" + pids.map((p) => `pid == ${p}`).join(" or ") + ")");
    }
    if (varRank()) c.push(`pid == ${varRank()}`);
    const a = adhocQuery().trim();
    if (a) c.push(`(${a})`);
    return c.join(" and ");
  };
  const ovFiltered = () =>
    ovBegin() > 0 ||
    (ovEnd() > 0 && ovEnd() < ovSpan()) ||
    !!varLayer() ||
    !!varHost() ||
    !!varRank() ||
    !!adhocQuery();
  const clearOvFilter = () => {
    setOvBegin(0);
    setOvEnd(0);
    setVarLayer("");
    setVarHost("");
    setVarRank("");
    setAdhocQuery("");
  };
  createEffect(() => {
    const s = autoRefresh();
    if (s <= 0) return;
    const t = setInterval(() => setRefreshNonce((n) => n + 1), s * 1000);
    onCleanup(() => clearInterval(t));
  });
  // Panel cards show their own per-card spinner; this drives it for the Solid
  // Top event types card, which re-queries on filter change.
  const [topEvBusy, setTopEvBusy] = createSignal(false);
  const [ovTopEvents, setOvTopEvents] = createSignal<{ name: string; count: number }[]>([]);
  let topEvInflight: AbortController | undefined;
  let topEvTimer: number | undefined;
  createEffect(() => {
    if (view() !== "overview" || ovSpan() <= 0) return;
    const b = ovBegin();
    const e = ovEnd() > 0 ? ovEnd() : ovSpan();
    const q = composedQuery();
    refreshNonce();
    setTopEvBusy(true);
    clearTimeout(topEvTimer);
    topEvTimer = window.setTimeout(() => {
      topEvInflight?.abort();
      const ac = new AbortController();
      topEvInflight = ac;
      fetchVizStats(b, e, q, "name", ac.signal)
        .then((s) => {
          if (ac.signal.aborted) return;
          setOvTopEvents(
            [...s.names]
              .sort((a, c) => c.count - a.count)
              .slice(0, 8)
              .map((n) => ({ name: n.name, count: n.count })),
          );
        })
        .catch(() => {})
        .finally(() => {
          if (!ac.signal.aborted) setTopEvBusy(false);
        });
    }, 300);
  });
  const renderCard = (id: string) => {
    if (id === "top_events")
      return (
        <section class="ov-card" classList={{ "ov-loading": topEvBusy() }}>
          <div class="ov-card-head">
            <h3>Top event types</h3>
            <span class="ov-sub">{ovTopEvents().length} types</span>
          </div>
          <div class="ov-bars">
            <For each={ovTopEvents()} fallback={<div class="ov-empty">No events yet</div>}>
              {(c) => (
                <button
                  class="ov-bar-row"
                  title={`open ${c.name} in timeline`}
                  onClick={() => {
                    filterByName(c.name);
                    setSearchParams({ view: "timeline" });
                  }}
                >
                  <span class="ov-bar-name">
                    <i style={{ background: colorFor(c.name) }} />
                    {c.name}
                  </span>
                  <span class="ov-bar-track">
                    <span
                      class="ov-bar-fill"
                      style={{
                        width: `${(c.count / (ovTopEvents()[0]?.count || 1)) * 100}%`,
                        background: colorFor(c.name),
                      }}
                    />
                  </span>
                  <span class="ov-bar-val">{c.count.toLocaleString()}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      );
    if (id === "runs")
      return (
        <section class="ov-card">
          <div class="ov-card-head">
            <h3>Runs</h3>
            <span class="ov-sub">{runs().length.toLocaleString()} runs</span>
          </div>
          <div class="ov-runs">
            <div class="ov-runs-head">
              <span>run</span>
              <span>format</span>
              <span>state</span>
              <span class="num">files</span>
              <span class="num">events</span>
              <span class="num">bytes</span>
              <span class="num">span</span>
            </div>
            <For
              each={runs().slice(-OV_RUNS_ROWS).reverse()}
              fallback={<div class="ov-empty">Waiting for the first trace records</div>}
            >
              {(r) => (
                <button
                  class="ov-runs-row"
                  classList={{ active: activeRun() === r.id }}
                  title={`${r.dir} · ${r.reason}`}
                  onClick={() => selectRun(r.id === activeRun() ? "" : r.id)}
                >
                  <span class="ov-runs-id">{r.id}</span>
                  <span>{r.format}</span>
                  <span class={`ov-runs-state ${r.state}`}>{r.state}</span>
                  <span class="num">{r.files.toLocaleString()}</span>
                  <span class="num">{r.events.toLocaleString()}</span>
                  <span class="num">{formatBytes(r.bytes)}</span>
                  <span class="num">{formatTime(r.last_ts - r.first_ts)}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      );
    if (id === "idle")
      return (
        <section class="ov-card">
          <div class="ov-card-head">
            <h3>Idle between runs</h3>
            <span class="ov-sub">full trace</span>
          </div>
          <div class="ov-list">
            <For each={topBreaks()} fallback={<div class="ov-empty">Single continuous run</div>}>
              {(g) => (
                <button
                  class="ov-list-row"
                  title="zoom to this gap"
                  onClick={() => {
                    setSearchParams({ view: "timeline" });
                    requestAnimationFrame(() => timeline?.focusRange(g.t0, g.t1));
                  }}
                >
                  <span class="ov-list-name">at {formatTime(g.t0)}</span>
                  <span class="ov-list-val">{formatTime(g.dur)}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      );
    return <div id={`pcard-${id}`} class="ov-panelslot" />;
  };
  const [theme, setTheme] = createSignal<"dark" | "light">(initialTheme());
  const [kpis, setKpis] = createSignal<{
    wall: number;
    totalIO: number;
    ioShare: number;
    procs: number;
  } | null>(null);

  // persist=true records an explicit user choice; the initial sync and
  // OS-preference changes leave localStorage untouched so we keep following
  // the OS until the user actually picks.
  function applyTheme(m: "dark" | "light", persist = false) {
    setTheme(m);
    document.documentElement.dataset.theme = m;
    timeline?.setTheme(m);
    flame?.setTheme(m);
    bottomFlame?.setTheme(m);
    inspCallersFg?.setTheme(m);
    inspCalleesFg?.setTheme(m);
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, m);
      } catch {
        /* ignore */
      }
    }
  }

  createEffect(() => {
    const t = anFlameTree();
    if (bottomTab() === "calltree") bottomFlame?.setTree(t);
  });
  createEffect(() => inspCallersFg?.setTree(inspCallersRoot()));
  createEffect(() => inspCalleesFg?.setTree(inspCalleesRoot()));
  const [flameLoading, setFlameLoading] = createSignal(false);
  const [flameHover, setFlameHover] = createSignal<FlameHover | null>(null);
  const [bottomFlameHover, setBottomFlameHover] = createSignal<FlameHover | null>(null);
  const [flameTree, setFlameTree] = createSignal<FlameNode | null>(null);
  const [flameTreeGrouped, setFlameTreeGrouped] = createSignal(false);
  const [byProcess, setByProcess] = createSignal(false);
  const [queryText, setQueryText] = createSignal("");
  const [appliedQuery, setAppliedQuery] = createSignal("");
  const [fullDetail, setFullDetail] = createSignal(false);
  const [colorBy, setColorBy] = createSignal<"category" | "size" | "latency">("category");
  const [showCounters, setShowCounters] = createSignal(true);
  // The timeline's current visible window (real us), kept in sync so the counter
  // overlay aligns with the tracks and follows pan/zoom.
  const [tlView, setTlView] = createSignal<{ begin: number; end: number }>({ begin: 0, end: 0 });
  createEffect(() => {
    const s = ovSpan();
    if (s > 0 && tlView().end === 0) setTlView({ begin: 0, end: s });
  });
  // Ticks once per animated timeline frame so the counter overlay re-lays its
  // paths in lockstep with the tracks (smooth pan/zoom, not step-on-settle).
  const [frameTick, setFrameTick] = createSignal(0);

  const [counterH, setCounterH] = createSignal(320);
  const startCounterResize = (e: MouseEvent) => {
    const h0 = counterH();
    beginDragResize(e, (dy) =>
      setCounterH(Math.max(90, Math.min(window.innerHeight * 0.6, h0 + dy))),
    );
  };

  // A counter docked as per-lane background heat on the tracks (by pid).
  const [dockLane, setDockLane] = createSignal<{ id: string; color: string } | null>(null);
  const onDockLane = (id: string, color: string) => {
    const cur = dockLane();
    if (cur?.id === id) {
      setDockLane(null);
      timeline?.clearLaneCounter();
    } else {
      setDockLane({ id, color });
    }
  };
  const dockSplit = source.counterSplit(() => {
    const d = dockLane();
    const v = tlView();
    return d && v.end > v.begin
      ? { begin: v.begin, end: v.end, series: d.id, dim: "pid", width: 700, top: 256 }
      : null;
  });

  // System telemetry on the node rows: the chosen counter's percent components
  // stacked as a percent-of-row strip on each host lane; idle_pct/free_pct are
  // skipped so the strip reads as utilization with the remainder empty.
  const [nodeStrip, setNodeStrip] = createSignal("cpu");
  const NODE_STRIP_COLORS = ["#7fb36a", "#e6a13c", "#d1524e", "#5b8fd1", "#b06fc4", "#c98a5a"];
  const NODE_STRIP_ORDER = ["user_pct", "system_pct", "iowait_pct", "used_pct", "cached_pct"];
  const NODE_STRIP_SKIP = new Set(["idle_pct", "free_pct"]);
  const nodeCounterData = source.nodeCounters(() => {
    const v = tlView();
    return v.end > v.begin ? { begin: v.begin, end: v.end, width: 700 } : null;
  });
  const nodeStripNames = createMemo(() => {
    const names = new Set<string>();
    for (const h of nodeCounterData()?.hosts ?? []) for (const s of h.series) names.add(s.name);
    return [...names].sort();
  });
  const cycleNodeStrip = () => {
    const names = [...nodeStripNames(), "off"];
    if (names.length < 2) return;
    setNodeStrip(names[(names.indexOf(nodeStrip()) + 1) % names.length]);
  };
  createEffect(() => {
    // Read deps before the optional call: `timeline?.f(args)` skips evaluating
    // args while timeline is undefined, which would leave the effect untracked.
    const label = nodeStripNames().length ? nodeStrip() : null;
    timeline?.setNodeStripLabel(label);
  });
  createEffect(() => {
    const res = nodeCounterData();
    const name = nodeStrip();
    if (!res) return;
    if (name === "off") {
      timeline?.clearNodeCounters();
      return;
    }
    // Percent counters stack against 100 (idle/free omitted = utilization);
    // byte/count counters (net, disk) stack against the window's peak total
    // across hosts, like the bandwidth strip.
    const perHost = new Map<string, { key: string; values: number[]; counts?: number[] }[]>();
    let isPct = false;
    for (const h of res.hosts) {
      const sers = h.series.filter((s) => s.name === name && !NODE_STRIP_SKIP.has(s.key));
      if (!sers.length) continue;
      isPct = sers.some((s) => s.key.endsWith("_pct"));
      sers.sort((a, b) => {
        const ia = NODE_STRIP_ORDER.indexOf(a.key);
        const ib = NODE_STRIP_ORDER.indexOf(b.key);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.key.localeCompare(b.key);
      });
      perHost.set(
        h.host,
        sers.map((s) => ({ key: s.key, values: s.values, counts: s.counts })),
      );
    }
    let scale = 1;
    if (!isPct) {
      let peak = 1e-9;
      for (const sers of perHost.values()) {
        for (let i = 0; i < res.buckets; i++) {
          let t = 0;
          for (const s of sers) t += Math.max(0, s.values[i] || 0);
          if (t > peak) peak = t;
        }
      }
      scale = 100 / peak;
    }
    const byHost = new Map<string, { key: string; values: number[]; color: string }[]>();
    for (const [host, sers] of perHost) {
      byHost.set(
        host,
        sers.map((s, i) => ({
          key: s.key,
          values: s.values,
          counts: s.counts,
          color: NODE_STRIP_COLORS[i % NODE_STRIP_COLORS.length],
        })),
      );
    }
    if (byHost.size)
      timeline?.setNodeCounters(res.begin, res.bucket_us, res.buckets, byHost, scale);
    else timeline?.clearNodeCounters();
  });
  createEffect(() => {
    const res = dockSplit();
    const d = dockLane();
    if (!res || !d) return;
    const byPid = new Map<string, number[]>();
    let max = 1e-9;
    for (const e of res.entities) {
      if (e.entity === "__other__") continue;
      byPid.set(e.entity, e.values);
      if (e.max > max) max = e.max;
    }
    timeline?.setLaneCounter(res.begin, res.bucket_us, res.buckets, byPid, d.color, max);
  });
  const [selected, setSelected] = createSignal<TraceEvent | null>(null);
  const [hover, setHover] = createSignal<HoverState | null>(null);
  const [headerHelp, setHeaderHelp] = createSignal<{ text: string; x: number; y: number } | null>(
    null,
  );
  const help = (key: string) => {
    const text = METRIC_HELP[key];
    if (!text) return {};
    const show = (e: MouseEvent) => setHeaderHelp({ text, x: e.clientX, y: e.clientY });
    return { onMouseEnter: show, onMouseMove: show, onMouseLeave: () => setHeaderHelp(null) };
  };
  const [cats, setCats] = createSignal<CatStat[]>([]);
  const [showLegend, setShowLegend] = createSignal(false);
  const [searchTerm, setSearchTerm] = createSignal("");
  const [matchCount, setMatchCount] = createSignal(0);
  const [matchPos, setMatchPos] = createSignal(0);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showGaps, setShowGaps] = createSignal(false);
  // Impossible timings stay hidden until asked for: they drag the axis by days.
  const [showMalformed, setShowMalformed] = createSignal(false);
  const [multiRun, setMultiRun] = createSignal(false);
  const [breaks, setBreaks] = createSignal<{ begin: number; end: number }[]>([]);
  const topBreaks = () =>
    breaks()
      .map((g) => ({ t0: g.begin, t1: g.end, dur: g.end - g.begin }))
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 8);
  const [timelapse, setTimelapse] = createSignal(false);
  const [gaps, setGaps] = createSignal<Gap[]>([]);
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [analyzeTab, setAnalyzeTab] = createSignal<"name" | "file" | "pid" | "cat">("name");
  const [bottomTab, setBottomTab] = createSignal("summary");
  function selectBottomTab(id: string, group: AnGroup) {
    setBottomTab(id);
    if (id === "eventlog") {
      loadEventLog();
      return;
    }
    if (id === "bottlenecks" || id === "bottomup") {
      setAnalyzeTab("name"); // rows key on operation name (for the dist drill-down)
      setDistKey(null);
      setDistHist(null);
      loadAnFlame();
      return;
    }
    if (id === "calltree") {
      loadAnFlame();
      return;
    }
    if (group) loadAnalyze(group);
  }
  function reloadBottom() {
    const tab = bottomTab();
    if (tab === "eventlog") return loadEventLog();
    if (tab === "bottlenecks" || tab === "bottomup" || tab === "calltree") return loadAnFlame();
    const entry = BOTTOM_TABS.find(([bid]) => bid === tab);
    const group = entry ? entry[2] : "name";
    if (group) loadAnalyze(group);
  }
  function loadAnFlame() {
    if (totalSpan <= 0) return;
    const [b, e] = scopeRange();
    const q = appliedQuery();
    const key = `${q}|${Math.floor(b)}-${Math.ceil(e)}`;
    if (anFlameKey === key && !anFlameLoading()) return;
    anFlameInflight?.abort();
    const ac = new AbortController();
    anFlameInflight = ac;
    setAnFlameLoading(true);
    fetchCallTree(b, e, q, false, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        anFlameKey = key;
        setAnFlameTree(res.tree);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      })
      .finally(() => {
        if (anFlameInflight === ac) {
          setAnFlameLoading(false);
          anFlameInflight = undefined;
        }
      });
  }
  const [analyzeStats, setAnalyzeStats] = createSignal<SelectionStats | null>(null);
  const [analyzeLoading, setAnalyzeLoading] = createSignal(false);
  let analyzeInflight: AbortController | undefined;
  const [eventLog, setEventLog] = createSignal<TraceEvent[] | null>(null);
  const [eventLogLoading, setEventLogLoading] = createSignal(false);
  const [eventLogTruncated, setEventLogTruncated] = createSignal(false);
  let eventLogInflight: AbortController | undefined;
  // Separate from the Flamegraph view's tree so the two never clobber.
  const [anFlameTree, setAnFlameTree] = createSignal<FlameNode | null>(null);
  const [anFlameLoading, setAnFlameLoading] = createSignal(false);
  let anFlameInflight: AbortController | undefined;
  let anFlameKey: string | null = null;
  const isFlameTab = () => bottomTab() === "bottlenecks" || bottomTab() === "bottomup";
  // bottlenecks ranks by inclusive time, bottom-up by self (exclusive) time.
  const bottomFns = () => {
    const t = anFlameTree();
    if (!t) return [];
    const list = functionList([t]);
    return bottomTab() === "bottomup"
      ? list.sort((a, b) => b.self - a.self)
      : list.sort((a, b) => b.total - a.total);
  };
  // Cache Analyze results per (query, tab); the whole-trace scan is expensive.
  const analyzeCache = new Map<string, SelectionStats>();
  const [distKey, setDistKey] = createSignal<string | null>(null);
  const [distHist, setDistHist] = createSignal<HistogramResponse | null>(null);
  const [distLoading, setDistLoading] = createSignal(false);
  let distInflight: AbortController | undefined;
  const [inspHist, setInspHist] = createSignal<HistogramResponse | null>(null);
  let inspInflight: AbortController | undefined;
  const [inspSwName, setInspSwName] = createSignal<string | null>(null);
  const [inspSwTree, setInspSwTree] = createSignal<FlameNode | null>(null);
  const [inspSwHover, setInspSwHover] = createSignal<FlameHover | null>(null);
  let inspCallersFg: Flamegraph | undefined;
  let inspCalleesFg: Flamegraph | undefined;
  const inspCallersRoot = () => {
    const t = inspSwTree();
    const n = inspSwName();
    return t && n ? callersTree([t], n) : null;
  };
  const inspCalleesRoot = () => {
    const t = inspSwTree();
    const n = inspSwName();
    return t && n ? calleesTree([t], n) : null;
  };
  // Cached per query, shared by every selection's sandwich to avoid refetching.
  let inspTreeQuery: string | null = null;
  let inspTreePromise: Promise<FlameNode | null> | null = null;
  let searchInput: HTMLInputElement | undefined;
  // Resolution maps accumulated from HH/FH metadata (persist across fetches;
  // metadata has no ts so it only arrives on the full-range load).
  const [hostByHash, setHostByHash] = createSignal<Map<string, string>>(new Map());
  const [fileByHash, setFileByHash] = createSignal<Map<string, string>>(new Map());
  const hostByPid = new Map<string, string>();
  // Range the Analyze panel aggregates over; null means the whole trace.
  const [anScope, setAnScope] = createSignal<{ t0: number; t1: number } | null>(null);
  // Resizable analysis sidebar: bound its height so it cannot crush the tracks.
  const [sidebarH, setSidebarH] = createSignal(300);
  const startSbResize = (e: MouseEvent) => {
    const h0 = sidebarH();
    beginDragResize(e, (dy) =>
      setSidebarH(Math.max(140, Math.min(window.innerHeight * 0.7, h0 - dy))),
    );
  };
  const selCounterStats = source.counterSeries(() => {
    const s = anScope();
    return s && s.t1 > s.t0 ? { begin: s.t0, end: s.t1, width: 60 } : null;
  });
  const scopeRange = (): [number, number] => {
    const s = anScope();
    return s ? [s.t0, s.t1] : [0, totalSpan];
  };
  const scopeKey = () => {
    const s = anScope();
    return s ? `${Math.floor(s.t0)}-${Math.ceil(s.t1)}` : "all";
  };

  const [procRank, setProcRank] = createSignal<Map<string, string>>(new Map());
  const [fileCounts, setFileCounts] = createSignal<{ total: number; io: number } | null>(null);
  const [showSettings, setShowSettings] = createSignal(false);
  const [serverPath, setServerPath] = createSignal("");

  const summary = () => (fullDetail() ? 1 : 2);

  // Overscan buffer: the timeline holds slices for a window wider than the
  // viewport, so zooming/panning inside it needs no refetch (no data pop). We
  // only refetch when the viewport leaves the buffer, zooms in far enough that
  // the buffer is coarse, changes LOD, or the query changes.
  let totalSpan = 1;
  let loaded = { begin: 0, end: 0, summary: -1 };
  // Longest event duration seen so far; sent as `lookback` so the server also
  // returns events that started before the window but extend into it, without
  // scanning back to the start of the trace.
  let maxDurSeen = 0;
  let didAutoFit = false;

  function ensureData(begin: number, end: number, force = false) {
    const s = summary();
    const span = Math.max(1, end - begin);
    const bufferSpan = loaded.end - loaded.begin;
    const insideBuffer =
      !force &&
      s === loaded.summary &&
      begin >= loaded.begin &&
      end <= loaded.end &&
      bufferSpan <= span * 4; // buffer not so wide the detail is stale
    if (insideBuffer) return;
    const margin = span; // 1x overscan each side (3x window)
    const fb = Math.max(0, begin - margin);
    const fe = Math.min(totalSpan, end + margin);
    loaded = { begin: fb, end: fe, summary: s };
    requestData(fb, fe);
  }

  // Whole-trace per-lane overview for the minimap heatmap. Coarse (served from
  // the mipmap when unfiltered) and re-fetched whenever the query changes so the
  // minimap matches the filtered tracks. Best-effort; supersedes in flight.
  function loadOverview() {
    if (totalSpan <= 0) return;
    overviewInflight?.abort();
    const key = appliedQuery();
    const cached = overviewCache.get(key);
    if (cached) {
      timeline?.setOverview(cached);
      return;
    }
    const ac = new AbortController();
    overviewInflight = ac;
    fetchOverviewDensity(totalSpan, key, timeline?.viewportWidth(), ac.signal)
      .then((density) => {
        if (ac.signal.aborted) return;
        overviewCache.set(key, density);
        timeline?.setOverview(density);
      })
      .catch(() => {});
  }

  // The sandwich always fetches the grouped tree (so it can scope to a process
  // client-side); the flamegraph groups only when its toggle is on.
  const flameGrouped = () => (view() === "sandwich" ? true : byProcess());

  function loadFlame() {
    if (totalSpan <= 0) return;
    const q = appliedQuery();
    const grouped = flameGrouped();
    const key = `${q}|${grouped ? "p" : ""}`;
    if (flameLoadedQuery === key && !flameLoading()) return;
    flameInflight?.abort();
    const ac = new AbortController();
    flameInflight = ac;
    setFlameLoading(true);
    fetchCallTree(0, totalSpan, q, grouped, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        flameLoadedQuery = key;
        setFlameTreeGrouped(grouped);
        setFlameTree(res.tree);
        flame?.setTree(res.tree);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      })
      .finally(() => {
        if (flameInflight === ac) {
          setFlameLoading(false);
          flameInflight = undefined;
        }
      });
  }

  // Byte and I/O-share totals are computed during the single info() scan, so
  // the header needs no separate counters/stats passes over the trace.
  function loadKpis(procs: number) {
    const i = info();
    setKpis({
      wall: totalSpan,
      totalIO: i?.total_bytes ?? 0,
      ioShare: i?.io_share ?? 0,
      procs,
    });
  }

  function loadInspHist(name: string) {
    inspInflight?.abort();
    const ac = new AbortController();
    inspInflight = ac;
    setInspHist(null);
    const esc = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const q = appliedQuery();
    const pred = `name == "${esc}"`;
    fetchHistogram(0, totalSpan, q ? `(${q}) and ${pred}` : pred, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setInspHist(r);
      })
      .catch(() => {});
  }

  function ensureInspTree(): Promise<FlameNode | null> {
    const q = appliedQuery();
    if (inspTreeQuery === q && inspTreePromise) return inspTreePromise;
    inspTreeQuery = q;
    inspTreePromise = fetchCallTree(0, totalSpan, q, false)
      .then((r) => r.tree)
      .catch(() => null);
    return inspTreePromise;
  }

  async function loadInspSandwich(name: string) {
    setInspSwName(name);
    setInspSwTree(null);
    const tree = await ensureInspTree();
    if (inspSwName() !== name) return; // superseded by a newer selection
    setInspSwTree(tree);
  }

  function inspRows(ev: TraceEvent): [string, string][] {
    if (isAggregated(ev)) {
      return [
        ["events", Number(ev.count ?? 0).toLocaleString()],
        ["busy", formatTime(Number(ev.total ?? 0))],
        ["pid/tid", `${String(ev.pid)}/${String(ev.tid)}`],
        ["start", formatTime(Number(ev.ts) || 0)],
      ];
    }
    const args = (ev.args ?? {}) as Record<string, unknown>;
    const dur = Number(ev.dur) || 0;
    const rows: [string, string][] = [
      ["layer", String(ev.cat ?? "-")],
      ["start", formatTime(Number(ev.ts) || 0)],
      ["duration", formatTime(dur)],
    ];
    const size = Number(args.size ?? args.ret ?? args.image_size);
    if (Number.isFinite(size) && size > 0) {
      rows.push(["size", formatBytes(size)]);
      if (dur > 0) rows.push(["bandwidth", formatBytesPerSec(size / (dur / 1e6))]);
    }
    if (args.offset != null) {
      const off = Number(args.offset);
      rows.push([
        "offset",
        Number.isFinite(off) ? "0x" + off.toString(16).toUpperCase() : String(args.offset),
      ]);
    }
    if (args.fd != null) rows.push(["fd", String(args.fd)]);
    return rows;
  }

  function resolvedRows(ev: TraceEvent): [string, string][] {
    const args = (ev.args ?? {}) as Record<string, unknown>;
    const out: [string, string][] = [];
    if (args.hhash != null) {
      const host = hostByHash().get(String(args.hhash));
      if (host) out.push(["host", host]);
    }
    if (args.fhash != null) {
      const file = fileByHash().get(String(args.fhash));
      if (file) out.push(["file", file]);
    }
    return out;
  }

  createEffect(() => {
    const v = view();
    if (v === "flamegraph" || v === "sandwich") loadFlame();
  });

  async function requestData(begin: number, end: number) {
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    setLoading(true);
    setError(null);
    // Slices stream in one Arrow batch per file; accumulate across batches.
    const events: TraceEvent[] = [];
    const density: DensityBlock[] = [];
    try {
      await fetchTimelineStream(
        {
          begin,
          end,
          summary: summary(),
          query: appliedQuery(),
          lookback: maxDurSeen,
          width: timeline?.viewportWidth(),
        },
        (b) => {
          if (ac.signal.aborted) return;
          events.push(...b.events);
          density.push(...b.density);
          for (const e of b.events) {
            const d = Number(e.dur);
            if (Number.isFinite(d) && d > maxDurSeen) maxDurSeen = d;
          }
        },
        ac.signal,
      );
      if (ac.signal.aborted) return;
      // Paint once: setData relayouts every lane, so per-batch painting would
      // thrash the whole gutter. The stream still cuts latency and scans once.
      timeline?.setData(events, density);
      setMeta({
        begin,
        end,
        count: events.length + density.reduce((s, b) => s + b.count, 0),
        limit: 0,
        truncated: false,
        ts_normalized: true,
        global_min_timestamp_us: 0,
      });

      // Single-file view: the file's data may be a tiny sliver of the global
      // (multi-node) span, so fit the viewport to it on first load.
      if (SINGLE_FILE && !didAutoFit) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const e of events) {
          const t = Number(e.ts);
          if (Number.isFinite(t)) {
            lo = Math.min(lo, t);
            hi = Math.max(hi, t + (Number(e.dur) || 0));
          }
        }
        for (const b of density) {
          lo = Math.min(lo, b.ts);
          hi = Math.max(hi, b.ts + (Number(b.dur) || 0));
        }
        if (Number.isFinite(lo) && hi > lo && hi - lo < totalSpan * 0.9) {
          didAutoFit = true;
          timeline?.focusRange(lo, hi);
        }
      }

      // Counter track (bandwidth) for the same window; fire-and-forget so it
      // never blocks the slice data.
      counterInflight?.abort();
      const cac = new AbortController();
      counterInflight = cac;
      fetchVizCounters(begin, end, appliedQuery(), 1200, cac.signal)
        .then((c) => {
          if (!cac.signal.aborted)
            timeline?.setCounters(c.begin, c.bucket_us, c.read_bytes, c.write_bytes);
        })
        .catch(() => {});

      const counts = new Map<string, number>();
      for (const b of density) {
        if (b.name) counts.set(b.name, (counts.get(b.name) ?? 0) + b.count);
      }
      const hh = new Map(hostByHash());
      const fh = new Map(fileByHash());
      let resolvedChanged = false;
      for (const ev of events) {
        const args = (ev.args ?? {}) as Record<string, unknown>;
        if (ev.ph === "M") {
          const val = args.value != null ? String(args.value) : "";
          const nm = args.name != null ? String(args.name) : "";
          if (ev.name === "HH" && val && nm && hh.get(val) !== nm) {
            hh.set(val, nm);
            resolvedChanged = true;
          } else if (ev.name === "FH" && val && nm && fh.get(val) !== nm) {
            fh.set(val, nm);
            resolvedChanged = true;
          }
          continue;
        }
        const c = sliceKey(ev);
        if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
        if (args.hhash != null && !hostByPid.has(String(ev.pid))) {
          hostByPid.set(String(ev.pid), String(args.hhash));
        }
      }
      if (resolvedChanged) {
        setHostByHash(hh);
        setFileByHash(fh);
      }
      setCats(
        [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      );

      const hosts = new Map<number, string>();
      for (const [pid, hash] of hostByPid) {
        const host = hh.get(hash);
        if (host) hosts.set(Number(pid), host);
      }
      timeline?.setHosts(hosts);
      setGaps(timeline?.topGaps(15) ?? []);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      loaded.summary = -1; // invalidate buffer so we retry on next change
      setError((err as Error).message);
    } finally {
      if (inflight === ac) {
        setLoading(false);
        inflight = undefined;
      }
    }
  }

  function requestSelection(t0: number, t1: number) {
    setSelected(null);
    setAnScope({ t0, t1 });
    setSidebarOpen(true);
    reloadBottom();
  }

  function clearSelection() {
    if (anScope() === null) return;
    setAnScope(null);
    timeline?.clearSelection();
    if (sidebarOpen()) reloadBottom();
  }

  function afterQueryChange() {
    loadOverview();
    if (view() === "flamegraph" || view() === "sandwich") loadFlame();
    const vp = timeline?.getViewport();
    if (vp) ensureData(vp.begin, vp.end, true);
  }

  function applyQuery(e?: Event) {
    e?.preventDefault();
    setAppliedQuery(queryText());
    afterQueryChange();
  }

  function filterByName(name: string) {
    // The query DSL has no string escapes, so such a name cannot be expressed.
    if (name.includes('"') || name.includes("\\")) {
      setError(`Cannot filter on a name containing a quote or backslash: ${name}`);
      return;
    }
    const q = `name == "${name}"`;
    setQueryText(q);
    setAppliedQuery(q);
    afterQueryChange();
  }

  function clearQuery() {
    setQueryText("");
    setAppliedQuery("");
    afterQueryChange();
  }

  function doSearch(term: string) {
    setSearchTerm(term);
    setMatchCount(timeline?.setSearch(term) ?? 0);
    setMatchPos(0);
  }

  function navMatch(dir: 1 | -1) {
    if (matchCount() > 0) setMatchPos(timeline?.focusMatch(dir) ?? 0);
  }

  async function loadAnalyze(tab: "name" | "file" | "pid" | "cat") {
    setAnalyzeTab(tab);
    setDistKey(null);
    setDistHist(null);
    analyzeInflight?.abort();
    const cacheKey = `${appliedQuery()}|${tab}|${scopeKey()}`;
    const cached = analyzeCache.get(cacheKey);
    if (cached) {
      setAnalyzeStats(cached);
      setAnalyzeLoading(false);
      return;
    }
    const ac = new AbortController();
    analyzeInflight = ac;
    setAnalyzeLoading(true);
    try {
      const group = tab === "file" ? "fhash" : tab;
      const [b, e] = scopeRange();
      const res = await fetchVizStats(b, e, appliedQuery(), group, ac.signal);
      if (!ac.signal.aborted) {
        analyzeCache.set(cacheKey, res);
        setAnalyzeStats(res);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      if (analyzeInflight === ac) {
        setAnalyzeLoading(false);
        analyzeInflight = undefined;
      }
    }
  }

  async function loadEventLog() {
    eventLogInflight?.abort();
    const ac = new AbortController();
    eventLogInflight = ac;
    setEventLogLoading(true);
    try {
      const [b, e] = scopeRange();
      const res = await fetchViz(
        { begin: b, end: e, summary: 1, query: appliedQuery(), limit: 1000 },
        ac.signal,
      );
      if (!ac.signal.aborted) {
        const evs = res.events.filter((e) => e.ph !== "M");
        evs.sort((a, b) => Number(a.ts) - Number(b.ts));
        setEventLog(evs);
        setEventLogTruncated(res.metadata.truncated);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      if (eventLogInflight === ac) {
        setEventLogLoading(false);
        eventLogInflight = undefined;
      }
    }
  }

  function analyzeLabel(raw: string): string {
    if (analyzeTab() === "file") return fileByHash().get(raw) ?? raw;
    if (analyzeTab() === "pid") {
      const host = hostByHash().get(hostByPid.get(raw) ?? "");
      return host ? `${host} / P${raw}` : `Process ${raw}`;
    }
    return raw;
  }

  // Query predicate narrowing to one Analyze row (null when not expressible,
  // e.g. the file tab keys on a resolved path, not the fhash we could filter on).
  function distPredicate(tab: string, raw: string): string | null {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (tab === "name") return `name == "${esc(raw)}"`;
    if (tab === "cat") return `cat == "${esc(raw)}"`;
    if (tab === "pid") return `pid == ${raw}`;
    return null;
  }

  async function loadDist(raw: string) {
    const pred = distPredicate(analyzeTab(), raw);
    if (!pred) return;
    setDistKey(raw);
    distInflight?.abort();
    const ac = new AbortController();
    distInflight = ac;
    setDistLoading(true);
    setDistHist(null);
    const q = appliedQuery();
    const combined = q ? `(${q}) and ${pred}` : pred;
    try {
      const [b, e] = scopeRange();
      const res = await fetchHistogram(b, e, combined, ac.signal);
      if (!ac.signal.aborted) setDistHist(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      if (distInflight === ac) {
        setDistLoading(false);
        distInflight = undefined;
      }
    }
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      navMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      doSearch("");
      searchInput?.blur();
    }
  }

  onMount(async () => {
    timeline = new Timeline(canvas, {
      onRangeChange: (b, e) => {
        ensureData(b, e);
        setTlView({ begin: b, end: e });
      },
      onFrame: () => setFrameTick((t) => (t + 1) & 0xffff),
      onNodeStripClick: cycleNodeStrip,
      // onHeaderHover already clears the shared tooltip each move; only set here.
      onNodeStripHover: (text, x, y) => {
        if (text) setHeaderHelp({ text, x, y });
      },
      onHover: (ev, x, y) => setHover(ev ? { ev, x, y } : null),
      onHeaderHover: (key, x, y) => {
        const text = key ? METRIC_HELP[key] : undefined;
        setHeaderHelp(text ? { text, x, y } : null);
      },
      onSelect: (ev) => {
        setSelected(ev);
        if (ev) {
          clearSelection();
          // Counter readings have no duration distribution or call context.
          if (ev.name != null && ev.ph !== "C") {
            loadInspHist(String(ev.name));
            loadInspSandwich(String(ev.name));
          }
        } else {
          setInspSwName(null);
          setInspSwTree(null);
        }
      },
      onSelectRange: (t0, t1) => requestSelection(t0, t1),
      onSelectRangeClear: () => clearSelection(),
    });
    timeline.setHideMalformed(!showMalformed());
    timeline.attachMinimap(minimap);
    timeline.attachCounters(counterCanvas);
    flame = new Flamegraph(flameCanvas, {
      onHover: (node, pct, x, y) => setFlameHover(node ? { node, pct, x, y } : null),
    });
    window.addEventListener("keydown", onGlobalKey);
    if (CONFIG.vscode) {
      onHostMessage((m) => {
        if (m.type === "serverPath" && typeof m.path === "string") setServerPath(m.path);
      });
      post({ type: "getServerPath" });
    }
    applyTheme(theme());
    // Follow OS changes until the user makes an explicit choice.
    if (typeof matchMedia === "function") {
      const mq = matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener?.("change", (e) => {
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(THEME_KEY);
        } catch {
          /* ignore */
        }
        if (saved !== "dark" && saved !== "light") applyTheme(e.matches ? "light" : "dark");
      });
    }
    if (NEEDS_LOAD) return; // no server yet; the load screen is shown instead
    // Runs come first: the strip must work while the tree is still empty.
    // A run named in the URL may be gone (tree wiped or a run directory
    // renamed), so settle the scope against the live list before asking for
    // window data, which would otherwise 404 with "no run: <id>".
    const bootRuns = await fetchRuns().catch(() => null);
    if (bootRuns) {
      applyRuns(bootRuns);
      if (currentRunScope() && !bootRuns.runs.some((r) => r.id === currentRunScope())) {
        clearRunScope();
      }
    }
    stopRuns = openRunsStream((f) => {
      setRunsFeed("live");
      const first = info() === null && f.runs.length > 0;
      if (applyRuns(f) && !first && atTail()) void refreshWindow();
      if (first) void recoverFromWaiting(); // the trace just appeared
    });
    setLoading(true); // show activity during the initial info scan, before slices stream
    try {
      const i = await fetchInfo();
      setInfo(i);
      await loadTrace(i);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("no run:") && currentRunScope()) {
        clearRunScope();
        location.reload(); // one reload, and the URL no longer names the run
        return;
      }
      setError(
        msg.includes("waiting for the first records")
          ? "Waiting for the first trace records. This page updates by itself."
          : `Failed to load /api/info: ${msg}`,
      );
      setLoading(false);
    }
  });

  function onGlobalKey(e: KeyboardEvent) {
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    } else if (e.key === "?" && !typing) {
      e.preventDefault();
      setShowHelp((v) => !v);
    } else if (e.key === "Escape" && showHelp()) {
      setShowHelp(false);
    } else if (e.key === "Escape" && anScope()) {
      clearSelection();
    }
  }

  onCleanup(() => {
    inflight?.abort();
    counterInflight?.abort();
    analyzeInflight?.abort();
    flameInflight?.abort();
    anFlameInflight?.abort();
    window.removeEventListener("keydown", onGlobalKey);
    stopRuns?.();
    timeline?.destroy();
    flame?.destroy();
    bottomFlame?.destroy();
    inspCallersFg?.destroy();
    inspCalleesFg?.destroy();
  });

  return (
    <TraceSourceContext.Provider value={source}>
      <div class="app">
        <Show when={headerHelp()}>
          {(h) => (
            <div
              class="tooltip help-tip"
              style={{ left: `${h().x + 14}px`, top: `${h().y + 18}px` }}
            >
              {h().text}
            </div>
          )}
        </Show>
        <Rail onSettings={() => setShowSettings((v) => !v)} settingsActive={showSettings()} />
        <div class="main">
          <Show when={loading()}>
            <div class="loadbar" />
          </Show>
          <Show when={view() !== "analysis" && kpis()}>
            {(k) => (
              <div class="kpi-strip">
                <div class="kpi">
                  <span {...help("wall time")}>wall time</span>
                  <b>{formatTime(k().wall)}</b>
                </div>
                <div class="kpi">
                  <span {...help("total i/o")}>total i/o</span>
                  <b>{formatBytes(k().totalIO)}</b>
                </div>
                <div class="kpi">
                  <span {...help("i/o share")}>i/o share</span>
                  <b class="hot">{k().ioShare.toFixed(1)}%</b>
                </div>
                <div class="kpi">
                  <span {...help("processes")}>processes</span>
                  <b>{k().procs}</b>
                </div>
                <Show when={fileCounts()}>
                  {(f) => (
                    <>
                      <div class="kpi">
                        <span {...help("files")}>files</span>
                        <b>{f().total.toLocaleString()}</b>
                      </div>
                      <div class="kpi">
                        <span {...help("i/o files")}>i/o files</span>
                        <b>{f().io.toLocaleString()}</b>
                      </div>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <Show when={view() !== "overview" && view() !== "analysis"}>
            <header class="toolbar">
              <form class="query" onSubmit={applyQuery}>
                <input
                  type="text"
                  placeholder='query, e.g.  dur >= 1000 and cat == "POSIX"'
                  value={queryText()}
                  onInput={(e) => setQueryText(e.currentTarget.value)}
                  spellcheck={false}
                />
                <button type="submit">Apply</button>
                <Show when={appliedQuery()}>
                  <button type="button" class="ghost" onClick={clearQuery}>
                    Clear
                  </button>
                </Show>
              </form>
              <Show when={view() === "timeline"}>
                <div class="search">
                  <input
                    ref={searchInput}
                    type="text"
                    placeholder="find (Ctrl+F)"
                    value={searchTerm()}
                    onInput={(e) => doSearch(e.currentTarget.value)}
                    onKeyDown={onSearchKey}
                    spellcheck={false}
                  />
                  <Show when={searchTerm()}>
                    <span class="match-count">
                      {matchCount()
                        ? matchPos()
                          ? `${matchPos()}/${matchCount()}`
                          : String(matchCount())
                        : "0"}
                    </span>
                    <button
                      type="button"
                      class="ghost sm"
                      title="previous (Shift+Enter)"
                      onClick={() => navMatch(-1)}
                    >
                      {"<"}
                    </button>
                    <button
                      type="button"
                      class="ghost sm"
                      title="next (Enter)"
                      onClick={() => navMatch(1)}
                    >
                      {">"}
                    </button>
                  </Show>
                </div>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={fullDetail()}
                    onChange={(e) => {
                      setFullDetail(e.currentTarget.checked);
                      const vp = timeline?.getViewport();
                      if (vp) ensureData(vp.begin, vp.end, true);
                    }}
                  />
                  Full detail
                </label>
                <button
                  type="button"
                  class="ghost"
                  classList={{ active: showLegend() }}
                  onClick={() => setShowLegend(!showLegend())}
                >
                  Legend
                </button>
                <button
                  type="button"
                  class="ghost"
                  classList={{ active: showGaps() }}
                  onClick={() => {
                    const v = !showGaps();
                    setShowGaps(v);
                    timeline?.setShowGaps(v);
                  }}
                >
                  Gaps
                </button>
                <button
                  type="button"
                  class="ghost"
                  classList={{ active: showMalformed() }}
                  title="show events whose timing is impossible for the process that wrote them"
                  onClick={() => {
                    const v = !showMalformed();
                    setShowMalformed(v);
                    timeline?.setHideMalformed(!v);
                  }}
                >
                  Bad timing
                </button>
                <Show when={multiRun()}>
                  <button
                    type="button"
                    class="ghost"
                    classList={{ active: timelapse() }}
                    title="Compress the dead time between separate runs"
                    onClick={() => {
                      const v = !timelapse();
                      setTimelapse(v);
                      timeline?.setTimelapse(v);
                    }}
                  >
                    Timelapse
                  </button>
                </Show>
                <select
                  class="ghost tl-colorby"
                  title="Color slices by category, transfer size, or latency"
                  value={colorBy()}
                  onChange={(e) => {
                    const v = e.currentTarget.value as "category" | "size" | "latency";
                    setColorBy(v);
                    timeline?.setColorMode(v);
                  }}
                >
                  <option value="category">color: category</option>
                  <option value="size">color: size</option>
                  <option value="latency">color: latency</option>
                </select>
                <button
                  type="button"
                  class="ghost"
                  classList={{ active: showCounters() }}
                  title="Overlay ph=C counter series (system / aggregate / profile)"
                  onClick={() => setShowCounters((v) => !v)}
                >
                  Counters
                </button>
              </Show>
              <Show when={view() === "flamegraph"}>
                <button
                  type="button"
                  class="ghost"
                  classList={{ active: byProcess() }}
                  title="Split the tree by process instead of merging all processes"
                  onClick={() => {
                    setByProcess(!byProcess());
                    loadFlame();
                  }}
                >
                  Group by process
                </button>
              </Show>
              <button
                type="button"
                class="ghost"
                classList={{ active: sidebarOpen() }}
                onClick={() => {
                  const open = !sidebarOpen();
                  setSidebarOpen(open);
                  if (open) loadAnalyze(analyzeTab());
                }}
              >
                Analyze
              </button>
              <Show when={view() !== "sandwich"}>
                <button
                  type="button"
                  class="ghost"
                  onClick={() =>
                    view() === "flamegraph" ? flame?.resetFocus() : timeline?.resetView()
                  }
                >
                  Reset
                </button>
              </Show>
              <button
                type="button"
                class="ghost"
                title="shortcuts (?)"
                onClick={() => setShowHelp(true)}
              >
                ?
              </button>
            </header>
          </Show>
          <Show when={runs().length > 0}>
            <div class="runs-bar">
              <button
                type="button"
                class="run-chip"
                classList={{ active: activeRun() === "" }}
                onClick={() => selectRun("")}
              >
                all runs
              </button>
              <For each={pinnedRuns()}>
                {(r) => (
                  <button
                    type="button"
                    class="run-chip"
                    classList={{
                      active: activeRun() === r.id,
                      live: r.state === "live",
                      done: r.state === "done",
                      stalled: r.state === "stalled",
                    }}
                    title={`${r.dir} · ${r.format} · ${r.reason} · ${r.files} files`}
                    onClick={() => selectRun(r.id === activeRun() ? "" : r.id)}
                  >
                    <span class="run-state" />
                    <span class="run-id">{r.id}</span>
                    <span class="run-meta">
                      {r.format} · {r.events.toLocaleString()}
                    </span>
                  </button>
                )}
              </For>
              <Show when={hiddenRuns() > 0}>
                <button
                  type="button"
                  class="run-chip more"
                  title="show every run"
                  onClick={() => setRunPicker(!runPicker())}
                >
                  +{hiddenRuns().toLocaleString()} more
                </button>
              </Show>
              <span class="runs-count">{runs().length.toLocaleString()} runs</span>
              <Show when={runsFeed() === "live"}>
                <span
                  class="runs-feed"
                  title={`live updates on /api/stream, tree watched by ${watchMode()}`}
                >
                  live
                </span>
              </Show>
            </div>
            <Show when={runPicker()}>
              <div class="runs-picker">
                <div class="runs-picker-head">
                  <input
                    class="runs-filter"
                    placeholder="filter by id, format, state or path"
                    value={runFilter()}
                    onInput={(e) => setRunFilter(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRunPicker(false);
                    }}
                  />
                  <span class="runs-picker-note">
                    {listedRuns().length.toLocaleString()} of {runs().length.toLocaleString()}
                  </span>
                  <button class="ghost sm" onClick={() => setRunPicker(false)}>
                    x
                  </button>
                </div>
                <div class="runs-list">
                  <For each={listedRuns()}>
                    {(r) => (
                      <button
                        type="button"
                        class="runs-row"
                        classList={{ active: activeRun() === r.id }}
                        title={r.dir}
                        onClick={() => {
                          selectRun(r.id === activeRun() ? "" : r.id);
                          setRunPicker(false);
                        }}
                      >
                        <span
                          class="run-state"
                          classList={{
                            live: r.state === "live",
                            done: r.state === "done",
                            stalled: r.state === "stalled",
                          }}
                        />
                        <span class="runs-row-id">{r.id}</span>
                        <span class="runs-row-meta">
                          {r.format} · {r.state} · {r.events.toLocaleString()} events
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Show>

          <Show when={showHelp()}>
            <div class="modal-backdrop" onClick={() => setShowHelp(false)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <div class="modal-head">
                  <b>Keyboard & mouse</b>
                  <button class="ghost sm" onClick={() => setShowHelp(false)}>
                    x
                  </button>
                </div>
                <table class="help">
                  <tbody>
                    <For
                      each={[
                        ["drag / two-finger swipe", "pan"],
                        ["wheel", "scroll lanes"],
                        ["ctrl+wheel / pinch", "zoom at cursor"],
                        ["W / S", "zoom in / out"],
                        ["A / D", "pan left / right"],
                        ["double-click", "zoom in"],
                        ["drag on ruler / shift+drag", "measure a range (stats)"],
                        ["click a slice", "details"],
                        ["Ctrl+F", "find events"],
                        ["Enter / Shift+Enter", "next / previous match"],
                        ["minimap: click / drag", "jump / zoom to region"],
                        ["?", "this help"],
                      ]}
                    >
                      {([k, v]) => (
                        <tr>
                          <td class="help-k">{k}</td>
                          <td class="help-v">{v}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </Show>

          <Show when={showSettings()}>
            <div class="modal-backdrop" onClick={() => setShowSettings(false)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <div class="modal-head">
                  <b>Settings</b>
                  <button class="ghost sm" onClick={() => setShowSettings(false)}>
                    x
                  </button>
                </div>
                <div class="settings-body">
                  <div class="settings-row">
                    <span>Theme</span>
                    <button
                      class="ghost sm"
                      onClick={() => applyTheme(theme() === "dark" ? "light" : "dark", true)}
                    >
                      {theme() === "dark" ? "Switch to light" : "Switch to dark"}
                    </button>
                  </div>
                  <Show when={CONFIG.vscode}>
                    <div class="settings-section">dftracer_server</div>
                    <div class="settings-row">
                      <span>Server path</span>
                      <input
                        type="text"
                        class="settings-input"
                        placeholder="dftracer_server"
                        value={serverPath()}
                        onChange={(e) => {
                          setServerPath(e.currentTarget.value);
                          post({ type: "setServerPath", path: e.currentTarget.value });
                        }}
                      />
                    </div>
                    <div class="settings-section">Load traces</div>
                    <div class="settings-row">
                      <button
                        class="ghost sm"
                        onClick={() => post({ type: "pickTrace", mode: "file" })}
                      >
                        Open trace file...
                      </button>
                      <button
                        class="ghost sm"
                        onClick={() => post({ type: "pickTrace", mode: "dir" })}
                      >
                        Open trace directory...
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <Show when={NEEDS_LOAD}>
            <div class="load-screen">
              <div class="load-card">
                <div class="load-title">DFDashboard</div>
                <Show when={CONFIG.error}>
                  <div class="load-error">{CONFIG.error}</div>
                </Show>
                <div class="load-field">
                  <label>dftracer_server path (this machine)</label>
                  <input
                    type="text"
                    class="settings-input"
                    placeholder="dftracer_server"
                    value={serverPath()}
                    onInput={(e) => setServerPath(e.currentTarget.value)}
                    onChange={(e) => post({ type: "setServerPath", path: e.currentTarget.value })}
                  />
                  <div class="muted sm">
                    Set the full path if it is not on PATH. When connected to a remote host, this is
                    the path on that host.
                  </div>
                </div>
                <div class="load-actions">
                  <button class="primary" onClick={() => post({ type: "pickTrace", mode: "dir" })}>
                    Open trace directory...
                  </button>
                  <button class="ghost" onClick={() => post({ type: "pickTrace", mode: "file" })}>
                    Open trace file...
                  </button>
                  <Show when={CONFIG.error}>
                    <button class="ghost" onClick={() => post({ type: "retry" })}>
                      Retry
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <div class="workspace">
            <Show when={sidebarOpen()}>
              <aside
                class="sidebar"
                style={{ height: `${sidebarH()}px`, "max-height": `${sidebarH()}px` }}
              >
                <div
                  class="tl-splitter"
                  title="drag to resize the analysis panel"
                  onMouseDown={startSbResize}
                />
                <div class="sidebar-head">
                  <b>
                    Analysis ·{" "}
                    <Show when={anScope()} fallback={<span>whole trace</span>}>
                      {(s) => (
                        <span class="scope-tag">selection {formatTime(s().t1 - s().t0)}</span>
                      )}
                    </Show>
                  </b>
                  <div class="head-actions">
                    <Show when={anScope()}>
                      <button class="ghost sm" onClick={clearSelection}>
                        analyze whole trace
                      </button>
                    </Show>
                    <button class="ghost sm" onClick={() => setSidebarOpen(false)}>
                      x
                    </button>
                  </div>
                </div>
                <Show when={anScope() && (selCounterStats()?.series.length ?? 0) > 0}>
                  <div class="sel-counters">
                    <For each={selCounterStats()!.series}>
                      {(s) => (
                        <span class="sel-counter">
                          <b>
                            {s.name}·{s.key}
                          </b>{" "}
                          {s.family === "aggregate"
                            ? `total ${formatCounterValue(
                                s.key,
                                s.values.reduce((a, b) => a + b, 0),
                              )} · peak ${formatCounterValue(s.key, s.max)}`
                            : `avg ${formatCounterValue(s.key, s.mean)} · max ${formatCounterValue(s.key, s.max)}`}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="tabs">
                  <For each={BOTTOM_TABS}>
                    {([id, label, group]) => (
                      <button
                        class="ghost sm"
                        classList={{ active: bottomTab() === id }}
                        onClick={() => selectBottomTab(id, group)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
                <div class="analyze-body">
                  <Show when={bottomTab() === "eventlog"}>
                    <Show when={eventLogLoading() && !eventLog()}>
                      <div class="muted">loading events...</div>
                    </Show>
                    <Show when={eventLog()}>
                      <table class="kv stats analyze-table op-table evlog-table">
                        <thead>
                          <tr>
                            <th class="num">time</th>
                            <th class="num">dur</th>
                            <th>operation</th>
                            <th>layer</th>
                            <th class="num">pid/tid</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={eventLog()}>
                            {(e) => {
                              const name = String(e.name ?? "");
                              return (
                                <tr>
                                  <td class="num">{formatTime(Number(e.ts))}</td>
                                  <td class="num">{formatTime(Number(e.dur))}</td>
                                  <td
                                    class="op-name"
                                    style={{ color: colorFor(name) }}
                                    title={name}
                                  >
                                    {name}
                                  </td>
                                  <td class="op-layer">{String(e.cat || layerOf(name))}</td>
                                  <td class="num">
                                    {String(e.pid)}/{String(e.tid)}
                                  </td>
                                </tr>
                              );
                            }}
                          </For>
                        </tbody>
                      </table>
                      <Show when={eventLogTruncated()}>
                        <div class="muted">showing first 1000 events (truncated)</div>
                      </Show>
                    </Show>
                  </Show>

                  <Show when={bottomTab() === "calltree"}>
                    <Show when={anFlameLoading() && !anFlameTree()}>
                      <div class="muted">building call tree...</div>
                    </Show>
                    <div class="bottom-flame">
                      <canvas
                        ref={(el) => {
                          bottomFlame?.destroy();
                          bottomFlame = new Flamegraph(el, {
                            onHover: (node, pct, x, y) =>
                              setBottomFlameHover(node ? { node, pct, x, y } : null),
                          });
                          bottomFlame.setTheme(theme());
                          bottomFlame.setTree(anFlameTree());
                        }}
                      />
                      <Show when={bottomFlameHover()}>{(h) => <FlameTooltip hover={h()} />}</Show>
                    </div>
                  </Show>

                  <Show when={isFlameTab()}>
                    <Show when={anFlameLoading() && !anFlameTree()}>
                      <div class="muted">building call tree...</div>
                    </Show>
                    <Show when={anFlameTree()}>
                      {(_flame) => {
                        const metricOf = (n: { self: number; total: number }) =>
                          bottomTab() === "bottomup" ? n.self : n.total;
                        const grand = () =>
                          Math.max(
                            1,
                            bottomFns().reduce((s2, n) => s2 + metricOf(n), 0),
                          );
                        return (
                          <table class="kv stats analyze-table op-table">
                            <thead>
                              <tr>
                                <th {...help("operation")}>operation</th>
                                <th {...help("layer")}>layer</th>
                                <th class="num" {...help("self")}>
                                  self
                                </th>
                                <th class="num" {...help("total")}>
                                  total
                                </th>
                                <th class="bar-col" {...help("wall share")}>
                                  {bottomTab() === "bottomup" ? "self share" : "wall share"}
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={bottomFns()}>
                                {(n) => {
                                  const pct = (metricOf(n) / grand()) * 100;
                                  const col = colorFor(n.name);
                                  return (
                                    <tr
                                      classList={{
                                        "row-click": true,
                                        active: distKey() === n.name,
                                      }}
                                      onClick={() => loadDist(n.name)}
                                    >
                                      <td
                                        class="analyze-name op-name"
                                        title={n.name}
                                        style={{ color: col }}
                                      >
                                        {n.name}
                                      </td>
                                      <td class="op-layer">{layerOf(n.name)}</td>
                                      <td class="num">{formatTime(n.self)}</td>
                                      <td class="num">{formatTime(n.total)}</td>
                                      <td class="bar-col op-share">
                                        <span
                                          class="bar"
                                          style={{ width: `${pct}%`, background: col }}
                                        />
                                        <span class="op-pct">{pct.toFixed(0)}%</span>
                                      </td>
                                    </tr>
                                  );
                                }}
                              </For>
                            </tbody>
                          </table>
                        );
                      }}
                    </Show>
                  </Show>

                  <Show when={analyzeLoading() && !analyzeStats()}>
                    <div class="muted">aggregating...</div>
                  </Show>
                  <Show
                    when={
                      analyzeStats() &&
                      bottomTab() !== "eventlog" &&
                      bottomTab() !== "calltree" &&
                      !isFlameTab()
                    }
                  >
                    {(_stats) => {
                      const rows = () => analyzeStats()!.names;
                      const grand = () =>
                        Math.max(
                          1,
                          rows().reduce((s2, n) => s2 + n.total, 0),
                        );
                      const isName = () => analyzeTab() === "name" || analyzeTab() === "pid";
                      return (
                        <table class="kv stats analyze-table op-table">
                          <thead>
                            <tr>
                              <th {...help("operation")}>
                                {analyzeTab() === "file"
                                  ? "file"
                                  : analyzeTab() === "pid"
                                    ? "process"
                                    : "operation"}
                              </th>
                              <th {...help("layer")}>layer</th>
                              <th class="num" {...help("total")}>
                                total
                              </th>
                              <th class="bar-col" {...help("wall share")}>
                                wall share
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={rows()}>
                              {(n) => {
                                const label = analyzeLabel(n.name);
                                const clickable = distPredicate(analyzeTab(), n.name) !== null;
                                const pct = (n.total / grand()) * 100;
                                const col = colorFor(n.name);
                                return (
                                  <tr
                                    classList={{
                                      "row-click": clickable,
                                      active: distKey() === n.name,
                                    }}
                                    onClick={() => loadDist(n.name)}
                                  >
                                    <td
                                      class="analyze-name op-name"
                                      classList={{ path: analyzeTab() === "file" }}
                                      title={label}
                                      style={{ color: isName() ? col : undefined }}
                                    >
                                      <Show when={analyzeTab() === "file"} fallback={label}>
                                        <div class="path-scroll">{label}</div>
                                      </Show>
                                    </td>
                                    <td class="op-layer">
                                      {analyzeTab() === "name" ? layerOf(n.name) : "-"}
                                    </td>
                                    <td class="num">{formatTime(n.total)}</td>
                                    <td class="bar-col op-share">
                                      <span
                                        class="bar"
                                        style={{ width: `${pct}%`, background: col }}
                                      />
                                      <span class="op-pct">{pct.toFixed(0)}%</span>
                                    </td>
                                  </tr>
                                );
                              }}
                            </For>
                          </tbody>
                        </table>
                      );
                    }}
                  </Show>
                </div>
                <Show when={distKey()}>
                  <div class="dist-panel">
                    <div class="dist-head">
                      <span>Duration distribution: {distKey()}</span>
                      <button
                        class="ghost sm"
                        onClick={() => {
                          setDistKey(null);
                          setDistHist(null);
                        }}
                      >
                        x
                      </button>
                    </div>
                    <Show when={distLoading()}>
                      <div class="muted">computing...</div>
                    </Show>
                    <Show when={distHist()}>
                      {(h) => {
                        const barMax = Math.max(1, ...h().buckets.map((b) => b.count));
                        return (
                          <>
                            <div class="dist-stats">
                              <div class="tile">
                                <span>count</span>
                                <b>{h().count.toLocaleString()}</b>
                              </div>
                              <div class="tile">
                                <span>p50</span>
                                <b>{formatTime(h().p50 ?? 0)}</b>
                              </div>
                              <div class="tile">
                                <span>p95</span>
                                <b>{formatTime(h().p95 ?? 0)}</b>
                              </div>
                              <div class="tile">
                                <span>p99</span>
                                <b>{formatTime(h().p99 ?? 0)}</b>
                              </div>
                              <div class="tile">
                                <span>max</span>
                                <b>{formatTime(h().max ?? 0)}</b>
                              </div>
                            </div>
                            <div class="dist-bars">
                              <For each={h().buckets}>
                                {(b) => (
                                  <div
                                    class="dist-bar"
                                    style={{ height: `${(b.count / barMax) * 100}%` }}
                                    title={`${formatTime(b.lo)} - ${formatTime(b.hi)}: ${b.count.toLocaleString()}`}
                                  />
                                )}
                              </For>
                            </div>
                            <div class="dist-axis">
                              <span>{formatTime(h().min ?? 0)}</span>
                              <span class="muted">duration (log scale)</span>
                              <span>{formatTime(h().max ?? 0)}</span>
                            </div>
                          </>
                        );
                      }}
                    </Show>
                  </div>
                </Show>
              </aside>
            </Show>

            <Show when={selected()}>
              <aside class="inspector">
                <div class="sidebar-head">
                  <b>SELECTION</b>
                  <Show when={selected()}>
                    {(ev) => (
                      <span class="muted sm">
                        {isAggregated(ev())
                          ? `${Number(ev().count).toLocaleString()} EVENTS`
                          : "1 EVENT"}
                      </span>
                    )}
                  </Show>
                </div>
                <Show when={selected()}>
                  {(ev) => (
                    <div class="insp-scroll">
                      <div class="insp-title">
                        <i style={{ background: colorFor(sliceKey(ev())) }} />
                        {String(ev().name ?? "")}
                        {isAggregated(ev()) ? "" : "()"}
                      </div>
                      <div class="insp-sub">
                        {String(ev().cat ?? "-").toUpperCase()}
                        <Show when={procRank().get(String(ev().pid))}>
                          {(r) => <> · RANK {r()}</>}
                        </Show>{" "}
                        · PROC {String(ev().pid)}
                      </div>
                      <table class="kv insp-kv">
                        <tbody>
                          <For each={inspRows(ev())}>
                            {([k, v]) => (
                              <tr>
                                <td class="k" {...help(k)}>
                                  {k}
                                </td>
                                <td class="v">{v}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                      <Show when={resolvedRows(ev()).length > 0}>
                        <div class="insp-resolved">
                          <div class="detail-sub">resolved</div>
                          <table class="kv">
                            <tbody>
                              <For each={resolvedRows(ev())}>
                                {([k, v]) => (
                                  <tr>
                                    <td class="k">{k}</td>
                                    <td class="v path" title={v}>
                                      {v}
                                    </td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </Show>
                      <Show when={isAggregated(ev())}>
                        <div class="muted sm">
                          Merged block. Zoom in to resolve individual events.
                        </div>
                      </Show>
                      <Show when={inspHist()}>
                        {(h) => {
                          const bm = Math.max(1, ...h().buckets.map((b) => b.count));
                          return (
                            <div class="insp-hist">
                              <div class="detail-sub">duration · {String(ev().name)}</div>
                              <div class="dist-bars sm">
                                <For each={h().buckets}>
                                  {(b) => (
                                    <div
                                      class="dist-bar"
                                      style={{ height: `${(b.count / bm) * 100}%` }}
                                      title={`${formatTime(b.lo)} - ${formatTime(b.hi)}: ${b.count}`}
                                    />
                                  )}
                                </For>
                              </div>
                              <div class="dist-axis">
                                <span>{formatTime(h().min ?? 0)}</span>
                                <span>p50 {formatTime(h().p50 ?? 0)}</span>
                                <span>{formatTime(h().max ?? 0)}</span>
                              </div>
                            </div>
                          );
                        }}
                      </Show>
                      <Show when={inspCallersRoot() && inspCallersRoot()!.children.length > 0}>
                        <div class="insp-sw">
                          <div class="detail-sub">callers</div>
                          <div class="insp-sw-flame">
                            <canvas
                              ref={(el) => {
                                inspCallersFg?.destroy();
                                inspCallersFg = new Flamegraph(el, {
                                  onHover: (node, pct, x, y) =>
                                    setInspSwHover(node ? { node, pct, x, y } : null),
                                });
                                inspCallersFg.setTheme(theme());
                                inspCallersFg.setTree(inspCallersRoot());
                              }}
                            />
                          </div>
                        </div>
                      </Show>
                      <Show when={inspCalleesRoot() && inspCalleesRoot()!.children.length > 0}>
                        <div class="insp-sw">
                          <div class="detail-sub">callees</div>
                          <div class="insp-sw-flame">
                            <canvas
                              ref={(el) => {
                                inspCalleesFg?.destroy();
                                inspCalleesFg = new Flamegraph(el, {
                                  onHover: (node, pct, x, y) =>
                                    setInspSwHover(node ? { node, pct, x, y } : null),
                                });
                                inspCalleesFg.setTheme(theme());
                                inspCalleesFg.setTree(inspCalleesRoot());
                              }}
                            />
                          </div>
                        </div>
                      </Show>
                      <Show when={inspSwHover()}>{(h) => <FlameTooltip hover={h()} />}</Show>
                      <Show when={flattenArgs(ev()).length > 0}>
                        <div class="insp-args">
                          <div class="detail-sub">args</div>
                          <table class="kv">
                            <tbody>
                              <For each={flattenArgs(ev())}>
                                {([k, v]) => (
                                  <tr>
                                    <td class="k">{k}</td>
                                    <td class="v">{v}</td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </aside>
            </Show>

            <div class="views">
              <div
                class="body overview-body"
                style={{ display: view() === "overview" ? "flex" : "none" }}
              >
                <div class="ov-toolbar">
                  <select
                    class="ov-dashsel"
                    title="switch dashboard"
                    value={currentDash()}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v === "__new__") {
                        e.currentTarget.value = currentDash();
                        newDash();
                      } else switchDash(v);
                    }}
                  >
                    <For each={dashNames()}>{(n) => <option value={n}>{n}</option>}</For>
                    <option value="__new__">+ New dashboard</option>
                  </select>
                  <Show when={editLayout()}>
                    <button type="button" class="ghost sm" onClick={renameDash}>
                      Rename
                    </button>
                    <Show when={dashNames().length > 1}>
                      <button type="button" class="ghost sm" onClick={deleteDash}>
                        Delete
                      </button>
                    </Show>
                  </Show>
                  <button
                    type="button"
                    class="ghost sm"
                    classList={{ active: editLayout() }}
                    onClick={() => setEditLayout((v) => !v)}
                  >
                    {editLayout() ? "Done" : "Edit layout"}
                  </button>
                  <Show when={layerCats().length > 0}>
                    <select
                      class="ov-var"
                      title="filter by I/O layer"
                      value={varLayer()}
                      onChange={(e) => setVarLayer(e.currentTarget.value)}
                    >
                      <option value="">All layers</option>
                      <For each={layerCats()}>{(c) => <option value={c}>{c}</option>}</For>
                    </select>
                  </Show>
                  <Show when={ovHosts().length > 1}>
                    <select
                      class="ov-var"
                      title="filter by host"
                      value={varHost()}
                      onChange={(e) => setVarHost(e.currentTarget.value)}
                    >
                      <option value="">All hosts</option>
                      <For each={ovHosts()}>{(h) => <option value={h}>{h}</option>}</For>
                    </select>
                  </Show>
                  <Show when={ovProcs().length > 1}>
                    <select
                      class="ov-var"
                      title="filter by process/rank"
                      value={varRank()}
                      onChange={(e) => setVarRank(e.currentTarget.value)}
                    >
                      <option value="">All processes</option>
                      <For each={ovProcs()}>
                        {(p) => <option value={String(p.pid)}>{p.label}</option>}
                      </For>
                    </select>
                  </Show>
                  <Show when={editLayout()}>
                    <div class="ov-add">
                      <button
                        type="button"
                        class="ghost sm"
                        onClick={() => setShowPicker((v) => !v)}
                      >
                        + Add card
                      </button>
                      <Show when={showPicker()}>
                        <div class="ov-picker">
                          <For
                            each={OV_CATALOG_IDS.filter((id) => !dash.layout()[id])}
                            fallback={<div class="ov-empty">All cards added</div>}
                          >
                            {(id) => (
                              <button
                                type="button"
                                class="ov-picker-item"
                                onClick={() => addOvCard(id)}
                              >
                                {OV_CATALOG[id].label}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                    <button type="button" class="ghost sm" onClick={dash.reset}>
                      Reset
                    </button>
                    <span class="ov-edit-hint">drag to move, corner to resize, x to remove</span>
                  </Show>
                  <div class="ov-filter">
                    <Show when={ovSpan() > 0}>
                      <RangeFilter
                        span={ovSpan()}
                        begin={ovBegin()}
                        end={ovEnd()}
                        onChange={(b, e) => {
                          setOvBegin(b);
                          setOvEnd(e);
                        }}
                      />
                    </Show>
                    <input
                      class="ov-query-input"
                      type="text"
                      spellcheck={false}
                      placeholder="filter, e.g. dur >= 1000"
                      value={adhocQuery()}
                      onChange={(e) => setAdhocQuery(e.currentTarget.value)}
                    />
                    <Show when={ovFiltered()}>
                      <button type="button" class="ghost sm" onClick={clearOvFilter}>
                        Clear
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="ghost sm"
                      title="refresh cards"
                      onClick={() => setRefreshNonce((n) => n + 1)}
                    >
                      &#8635;
                    </button>
                    <select
                      class="ov-var"
                      title="auto-refresh"
                      value={String(autoRefresh())}
                      onChange={(e) => setAutoRefresh(+e.currentTarget.value)}
                    >
                      <option value="0">Off</option>
                      <option value="10">10s</option>
                      <option value="30">30s</option>
                      <option value="60">60s</option>
                    </select>
                  </div>
                </div>
                <DashGrid
                  editing={editLayout()}
                  layout={dash.layout}
                  setPos={dash.setPos}
                  onRemove={dash.removeCard}
                  items={OV_CATALOG_IDS.map((id) => ({ id, el: renderCard(id) }))}
                />
                <PanelEmbed
                  cards={OV_PANEL_IDS}
                  begin={ovBegin() > 0 ? String(Math.round(ovBegin())) : ""}
                  end={ovEnd() > 0 && ovEnd() < ovSpan() ? String(Math.round(ovEnd())) : ""}
                  query={composedQuery()}
                  nonce={refreshNonce()}
                  visible={view() === "overview"}
                  theme={theme()}
                />
              </div>
              <div class="body" style={{ display: view() === "timeline" ? "flex" : "none" }}>
                <div class="minimap-wrap">
                  <canvas ref={minimap} />
                </div>
                <div class="counter-wrap">
                  <canvas ref={counterCanvas} />
                </div>
                <Show when={showCounters()}>
                  <div class="counters-zone" style={{ "max-height": `${counterH()}px` }}>
                    <CounterOverlay
                      begin={tlView().begin}
                      end={tlView().end || ovSpan()}
                      gutter={GUTTER}
                      tick={frameTick}
                      frac={(t) => timeline?.frac(t) ?? 0}
                      realAtFrac={(f) => timeline?.realAtFrac(f) ?? 0}
                      onZoomRange={(t0, t1) => timeline?.focusRealRange(t0, t1)}
                      onResetView={() => timeline?.resetView()}
                      onDockLane={onDockLane}
                      dockedLane={() => dockLane()?.id ?? null}
                    />
                  </div>
                  <div
                    class="tl-splitter"
                    title="drag to resize the counter panel"
                    onMouseDown={startCounterResize}
                  />
                </Show>
                <div class="canvas-wrap">
                  <canvas ref={canvas} />

                  <Show
                    when={(() => {
                      const m = meta() as (VizMetadata & { density_count?: number }) | null;
                      return !loading() && m && m.count === 0 && (m.density_count ?? 0) === 0;
                    })()}
                  >
                    <div class="empty-state">
                      No events {SINGLE_FILE ? "in this file" : "in this view"}
                    </div>
                  </Show>

                  <Show when={showLegend() && cats().length > 0}>
                    <div class="legend-panel">
                      <div class="panel-head">
                        <span>Categories ({cats().length})</span>
                        <button class="ghost sm" onClick={() => setShowLegend(false)}>
                          x
                        </button>
                      </div>
                      <div class="legend-list">
                        <For each={cats()}>
                          {(c) => (
                            <button
                              class="legend-item"
                              title={`filter to ${c.name}`}
                              onClick={() => filterByName(c.name)}
                            >
                              <i style={{ background: colorFor(c.name) }} />
                              <span class="legend-name">{c.name}</span>
                              <span class="legend-count">{c.count.toLocaleString()}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={showGaps() && gaps().length > 0}>
                    <div class="legend-panel gaps-panel">
                      <div class="panel-head">
                        <span>Largest idle periods</span>
                        <button
                          class="ghost sm"
                          onClick={() => {
                            setShowGaps(false);
                            timeline?.setShowGaps(false);
                          }}
                        >
                          x
                        </button>
                      </div>
                      <div class="legend-list">
                        <For each={gaps()}>
                          {(g) => (
                            <button
                              class="legend-item"
                              title="zoom to gap"
                              onClick={() => timeline?.focusRange(g.t0, g.t1)}
                            >
                              <span class="legend-name">{g.label}</span>
                              <span class="legend-count">{formatTime(g.dur)}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={hover()}>
                    {(h) => (
                      <div
                        class="tooltip"
                        style={{ left: `${h().x + 14}px`, top: `${h().y + 14}px` }}
                      >
                        <div class="tt-name">
                          <i style={{ background: colorFor(sliceKey(h().ev)) }} />
                          {String(h().ev.name ?? "")}
                          <Show when={isAggregated(h().ev)}>
                            <span class="agg-tag">merged</span>
                          </Show>
                        </div>
                        <For each={inspRows(h().ev)}>
                          {([k, v]) => (
                            <div class="tt-row">
                              <span>{k}</span>
                              <b>{v}</b>
                            </div>
                          )}
                        </For>
                        <For each={resolvedRows(h().ev)}>
                          {([k, v]) => (
                            <div class="tt-row">
                              <span>{k}</span>
                              <b>{v}</b>
                            </div>
                          )}
                        </For>
                        <Show when={isAggregated(h().ev)}>
                          <div class="tt-row">
                            <span class="hint2">zoom in to resolve</span>
                          </div>
                        </Show>
                        <For each={flattenArgs(h().ev).slice(0, 6)}>
                          {([k, v]) => (
                            <div class="tt-row">
                              <span>{k}</span>
                              <b>{v}</b>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                </div>
              </div>

              <div
                class="body flame-body"
                style={{ display: view() === "flamegraph" ? "flex" : "none" }}
              >
                <div class="flame-wrap">
                  <canvas ref={flameCanvas} />
                  <Show when={flameLoading()}>
                    <div class="flame-overlay muted">building call tree...</div>
                  </Show>
                  <Show when={flameHover()}>{(h) => <FlameTooltip hover={h()} />}</Show>
                </div>
              </div>

              <Show when={view() === "sandwich"}>
                <div class="body">
                  <Show
                    when={flameTree()}
                    fallback={<div class="muted flame-overlay">building call tree...</div>}
                  >
                    {(t) => <SandwichView tree={t()} grouped={flameTreeGrouped()} mode={theme()} />}
                  </Show>
                </div>
              </Show>

              <Show when={view() === "provenance"}>
                <div class="body">
                  <ProvenanceView mode={theme()} />
                </div>
              </Show>

              <Show when={view() === "api"}>
                <div class="body api-body">
                  <ApiExplorer />
                </div>
              </Show>

              <Analysis active={view() === "analysis"} />
            </div>
          </div>

          <LogConsole />
          <StatusBar>
            <Show when={view() !== "analysis"}>
              <Show when={loading()}>
                <span class="spin">loading...</span>
              </Show>
              <Show when={error()}>
                <span class="err">{error()}</span>
              </Show>
              <Show when={meta()}>
                {(m) => (
                  <>
                    <span>{m().count.toLocaleString()} events</span>
                    <span>summary {summary()}</span>
                    <Show when={m().truncated}>
                      <span class="warn">truncated at {m().limit.toLocaleString()}</span>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={info()}>{(i) => <span>{i().file_count} files</span>}</Show>
              <Show when={view() !== "overview"}>
                <span class="hint">
                  <Show
                    when={view() === "flamegraph"}
                    fallback="drag or two-finger swipe to pan · pinch or ctrl+wheel to zoom · W/A/S/D keys · drag ruler to measure"
                  >
                    click a frame to zoom in · click a parent frame to zoom out · width = total time
                  </Show>
                </span>
              </Show>
            </Show>
          </StatusBar>
        </div>
      </div>
    </TraceSourceContext.Provider>
  );
}

function renderValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function isAggregated(ev: TraceEvent): boolean {
  return (ev as Record<string, unknown>).aggregated === true;
}

// Flatten nested args objects into dotted-key rows (e.g. hw.gpu.mem -> value).
function flattenObject(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const rows = flattenObject(v as Record<string, unknown>, key);
      if (rows.length > 0) out.push(...rows);
      else out.push([key, "{}"]);
    } else {
      out.push([key, renderValue(v)]);
    }
  }
  return out;
}

function flattenArgs(ev: TraceEvent): [string, string][] {
  const args = ev.args;
  if (!args || typeof args !== "object") return [];
  return flattenObject(args as Record<string, unknown>);
}
