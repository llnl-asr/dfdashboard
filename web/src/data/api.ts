import type {
  CallTreeResponse,
  DensityBlock,
  HistogramResponse,
  InfoResponse,
  ProcTreeNode,
  SelectionStats,
  TraceEvent,
  VizCounters,
  VizQuery,
  VizResponse,
} from "./types";

import { CONFIG } from "./config";
import { splitSlices, type TimelineBatch } from "../timeline/slices";

export type { TimelineBatch };

// True when the view is scoped to a single trace file.
export const SINGLE_FILE = CONFIG.file !== "";

// The scope is passed in by the caller: the view owns it, this layer stays a
// set of pure functions. An empty scope means every run.
function withScope(params: URLSearchParams, scope: string): URLSearchParams {
  if (CONFIG.file) params.set("file", CONFIG.file);
  if (scope) params.set("run", scope);
  return params;
}

export interface RunInfo {
  id: string;
  dir: string;
  format: "raw" | "compact";
  state: "live" | "done" | "stalled";
  reason: "marker" | "end-record" | "verified" | "quiet" | "writing";
  version: number;
  files: number;
  bytes: number;
  events: number;
  first_ts: number;
  last_ts: number;
}

export interface RunsFrame {
  root: string;
  seq: number;
  runs: RunInfo[];
  watch?: "poll" | "events";
}

export function fetchRuns(scope: string, signal?: AbortSignal): Promise<RunsFrame> {
  return getJson<RunsFrame>(
    `/api/runs?${withScope(new URLSearchParams(), scope).toString()}`,
    signal,
  );
}

// Server-sent events: one frame per change while the directory tree is watched.
// Returns a disposer. Resolves to a no-op when EventSource is missing.
export function openRunsStream(onFrame: (f: RunsFrame) => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const url = apiUrl("/api/stream");
  const es = new EventSource(url);
  es.addEventListener("runs", (ev) => {
    try {
      onFrame(JSON.parse((ev as MessageEvent).data) as RunsFrame);
    } catch {
      /* a malformed frame must not kill the stream */
    }
  });
  return () => es.close();
}

// Prefix with the API base (VS Code webview) and append the access token.
export function apiUrl(url: string): string {
  let u = CONFIG.apiBase ? CONFIG.apiBase.replace(/\/$/, "") + url : url;
  if (CONFIG.token)
    u += (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(CONFIG.token);
  return u;
}

// Raw request for the in-app API explorer: returns the status and body text
// (never throws on a non-2xx, so the explorer can display error responses).
export async function apiRequest(path: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(apiUrl(path));
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

// API errors arrive as {"code": "...", "detail": "...", "status": 404}. The
// message is for the reader and the code is for the code: never branch on the
// text, a reworded message would silently break the recovery.
export class ApiFailure extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function apiFailure(status: number, statusText: string, body: string): ApiFailure {
  let code = "";
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { code?: unknown; detail?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    /* not json */
  }
  return new ApiFailure(detail || body || `${status} ${statusText}`, code, status);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(url), { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw apiFailure(res.status, res.statusText, text);
  }
  return (await res.json()) as T;
}

export function fetchInfo(scope: string, signal?: AbortSignal): Promise<InfoResponse> {
  return getJson<InfoResponse>(
    `/api/info?${withScope(new URLSearchParams(), scope).toString()}`,
    signal,
  );
}

export function fetchProcTree(
  scope: string,
  signal?: AbortSignal,
): Promise<{ nodes: ProcTreeNode[] }> {
  const params = new URLSearchParams();
  return getJson<{ nodes: ProcTreeNode[] }>(
    `/api/viz/proctree?${withScope(params, scope).toString()}`,
    signal,
  );
}

// The Arrow decoders are imported where they are used, so the entry chunk does
// not carry apache-arrow for a reader who never opens the timeline.
async function arrow() {
  return await import("./arrow");
}

// Events ride Arrow IPC. apache-arrow decodes int64 columns as BigInt, so
// numeric fields are coerced to Number for the timeline's arithmetic.
async function getArrowEvents(url: string, signal?: AbortSignal): Promise<TraceEvent[]> {
  const res = await fetch(apiUrl(url), { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  const { tableFromIPC } = await arrow();
  const table = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
  return table.toArray().map((r): TraceEvent => {
    const o = r as Record<string, unknown>;
    return {
      name: String(o.name ?? ""),
      cat: String(o.cat ?? ""),
      ph: String(o.ph ?? "X"),
      pid: Number(o.pid ?? 0),
      tid: Number(o.tid ?? 0),
      ts: Number(o.ts ?? 0),
      dur: Number(o.dur ?? 0),
    };
  });
}

export async function fetchViz(
  q: VizQuery,
  scope: string,
  signal?: AbortSignal,
): Promise<VizResponse> {
  const params = new URLSearchParams({
    begin: String(Math.floor(q.begin)),
    end: String(Math.ceil(q.end)),
  });
  if (q.query && q.query.trim()) params.set("query", q.query.trim());
  const events = await getArrowEvents(
    `/api/viz/events.arrow?${withScope(params, scope).toString()}`,
    signal,
  );
  return {
    events,
    metadata: {
      begin: q.begin,
      end: q.end,
      count: events.length,
      limit: q.limit ?? 0,
      truncated: false,
      ts_normalized: true,
      global_min_timestamp_us: 0,
    },
  };
}

export async function fetchTimelineStream(
  q: VizQuery,
  scope: string,
  onBatch: (b: TimelineBatch) => void,
  signal?: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({
    begin: String(Math.floor(q.begin)),
    end: String(Math.ceil(q.end)),
    summary: String(q.summary),
  });
  if (q.query && q.query.trim()) params.set("query", q.query.trim());
  if (q.lookback && q.lookback > 0) params.set("lookback", String(Math.ceil(q.lookback)));
  if (q.width && q.width > 0) params.set("width", String(Math.round(q.width)));
  const res = await fetch(
    apiUrl(`/api/viz/timeline.arrow?${withScope(params, scope).toString()}`),
    {
      signal,
    },
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  const { RecordBatchReader } = await arrow();
  const reader = await RecordBatchReader.from(res.body);
  for await (const batch of reader) {
    if (signal?.aborted) break;
    onBatch(splitSlices(batch));
  }
}

// Density blocks of the whole trace for the overview minimap.
export async function fetchOverviewDensity(
  span: number,
  query: string,
  width: number | undefined,
  scope: string,
  signal?: AbortSignal,
): Promise<DensityBlock[]> {
  const blocks: DensityBlock[] = [];
  await fetchTimelineStream(
    { begin: 0, end: span, summary: 2, query, width },
    scope,
    (b) => blocks.push(...b.density),
    signal,
  );
  return blocks;
}

export interface VizBreaks {
  gaps: { begin: number; end: number }[];
  multi_run: boolean;
  // Trustworthy timing window from the process start/end records, in
  // trace-relative us; an event outside it has impossible timing. 0 = unknown.
  valid_start?: number;
  valid_end?: number;
  max_life?: number;
}

export function fetchVizBreaks(scope: string, signal?: AbortSignal): Promise<VizBreaks> {
  const params = new URLSearchParams();
  return getJson<VizBreaks>(`/api/viz/breaks?${withScope(params, scope).toString()}`, signal);
}

export async function fetchVizCounters(
  begin: number,
  end: number,
  query: string,
  buckets: number,
  scope: string,
  signal?: AbortSignal,
): Promise<VizCounters> {
  const params = new URLSearchParams({
    begin: String(Math.floor(begin)),
    end: String(Math.ceil(end)),
    buckets: String(buckets),
  });
  if (query && query.trim()) params.set("query", query.trim());
  const res = await fetch(
    apiUrl(`/api/viz/counters.arrow?${withScope(params, scope).toString()}`),
    {
      signal,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  const { tableFromIPC } = await arrow();
  const table = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
  const col = (name: string) => Array.from(table.getChild(name)?.toArray() ?? [], Number);
  return {
    begin,
    end,
    buckets,
    bucket_us: Math.max((end - begin) / Math.max(buckets, 1), 1),
    truncated: false,
    read_bytes: col("read_bytes"),
    write_bytes: col("write_bytes"),
    ops: col("ops"),
  };
}

export function fetchCallTree(
  begin: number,
  end: number,
  query: string,
  byProcess: boolean,
  scope: string,
  signal?: AbortSignal,
): Promise<CallTreeResponse> {
  const params = new URLSearchParams({
    begin: String(Math.floor(begin)),
    end: String(Math.ceil(end)),
  });
  if (query && query.trim()) params.set("query", query.trim());
  if (byProcess) params.set("group", "pid");
  return getJson<CallTreeResponse>(
    `/api/viz/calltree?${withScope(params, scope).toString()}`,
    signal,
  );
}

export function fetchHistogram(
  begin: number,
  end: number,
  query: string,
  scope: string,
  signal?: AbortSignal,
): Promise<HistogramResponse> {
  const params = new URLSearchParams({
    begin: String(Math.floor(begin)),
    end: String(Math.ceil(end)),
  });
  if (query && query.trim()) params.set("query", query.trim());
  return getJson<HistogramResponse>(
    `/api/viz/histogram?${withScope(params, scope).toString()}`,
    signal,
  );
}

export function fetchVizStats(
  t0: number,
  t1: number,
  query: string,
  scope: string,
  group?: string,
  signal?: AbortSignal,
): Promise<SelectionStats> {
  const params = new URLSearchParams({
    begin: String(Math.floor(t0)),
    end: String(Math.ceil(t1)),
  });
  if (query && query.trim()) params.set("query", query.trim());
  if (group) params.set("group", group);
  return getJson<SelectionStats>(`/api/viz/stats?${withScope(params, scope).toString()}`, signal);
}

export interface LayersResponse {
  layers: Record<string, string>; // operation name -> category
  total_files: number; // files declared by FH metadata
  io_files: number; // files actually read from or written to
}

export function fetchLayers(scope: string, signal?: AbortSignal): Promise<LayersResponse> {
  return getJson<LayersResponse>(
    `/api/viz/layers?${withScope(new URLSearchParams(), scope).toString()}`,
    signal,
  );
}

// ---- provenance (/api/prov/graph) ----------------------------------------
export interface ProvEntity {
  hash: string;
  type: string;
  id: string;
  store: string;
  uri: string;
  pids: number[];
}
export interface ProvActivity {
  aid: string;
  name: string;
  activity: string;
  pid: number;
  ts: number;
  dur: number;
  used: string[];
  generated: string[];
  invalidated?: string[];
  updated?: string[];
  cat?: string;
}
export interface ProvEntityRelation {
  relation: string;
  subject: string;
  object: string;
}
export interface ProvFile {
  fhash: string;
  path: string;
  mount: string;
  rel: string;
}
export interface ProvMount {
  path: string;
  fstype: string;
}
export interface ProvAccess {
  aid: string;
  fhash: string;
  path: string;
  op: "read" | "write" | "open" | "delete" | "meta";
  calls: number;
  bytes: number;
}
export interface ProvType {
  name: string;
  role: string;
  description: string;
}
export interface ProvGraphResponse {
  entity_relations?: ProvEntityRelation[];
  types?: ProvType[];
  entities: ProvEntity[];
  activities: ProvActivity[];
  files?: ProvFile[];
  mounts?: ProvMount[];
  accesses?: ProvAccess[];
  entity_files?: { entity: string; fhash: string; path: string }[];
  stats: {
    entities: number;
    activities: number;
    entity_records: number;
    prov_events: number;
    cont_events: number;
    dangling_hashes: number;
    isolated_entities: number;
    truncated_activities: number;
    orphan_chunks: number;
    files?: number;
    mounts?: number;
    io_events?: number;
    io_attributed?: number;
    files_excluded?: number;
  };
}

export function fetchProvGraph(
  params: { io?: boolean; allFiles?: boolean; mounts?: string },
  scope: string,
  signal?: AbortSignal,
): Promise<ProvGraphResponse> {
  const p = new URLSearchParams(withScope(new URLSearchParams(), scope));
  p.set("io", params.io === false ? "0" : "1");
  if (params.allFiles) p.set("all_files", "1");
  if (params.mounts) p.set("mounts", params.mounts);
  return getJson<ProvGraphResponse>(`/api/prov/graph?${p.toString()}`, signal);
}
