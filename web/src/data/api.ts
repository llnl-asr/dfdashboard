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

import { RecordBatchReader, tableFromIPC } from "apache-arrow";

import { CONFIG } from "./config";
import { splitSlices, type TimelineBatch } from "../timeline/slices";

export type { TimelineBatch };

// True when the view is scoped to a single trace file.
export const SINGLE_FILE = CONFIG.file !== "";

function withFile(params: URLSearchParams): URLSearchParams {
  if (CONFIG.file) params.set("file", CONFIG.file);
  return params;
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

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(url), { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchInfo(signal?: AbortSignal): Promise<InfoResponse> {
  return getJson<InfoResponse>("/api/info", signal);
}

export function fetchProcTree(signal?: AbortSignal): Promise<{ nodes: ProcTreeNode[] }> {
  const params = new URLSearchParams();
  return getJson<{ nodes: ProcTreeNode[] }>(
    `/api/viz/proctree?${withFile(params).toString()}`,
    signal,
  );
}

// Events ride Arrow IPC. apache-arrow decodes int64 columns as BigInt, so
// numeric fields are coerced to Number for the timeline's arithmetic.
async function getArrowEvents(url: string, signal?: AbortSignal): Promise<TraceEvent[]> {
  const res = await fetch(apiUrl(url), { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
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

export async function fetchViz(q: VizQuery, signal?: AbortSignal): Promise<VizResponse> {
  const params = new URLSearchParams({
    begin: String(Math.floor(q.begin)),
    end: String(Math.ceil(q.end)),
  });
  if (q.query && q.query.trim()) params.set("query", q.query.trim());
  const events = await getArrowEvents(`/api/viz/events.arrow?${withFile(params).toString()}`, signal);
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
  const res = await fetch(apiUrl(`/api/viz/timeline.arrow?${withFile(params).toString()}`), {
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
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
  signal?: AbortSignal,
): Promise<DensityBlock[]> {
  const blocks: DensityBlock[] = [];
  await fetchTimelineStream(
    { begin: 0, end: span, summary: 2, query, width },
    (b) => blocks.push(...b.density),
    signal,
  );
  return blocks;
}

export interface VizBreaks {
  gaps: { begin: number; end: number }[];
  multi_run: boolean;
}

export function fetchVizBreaks(signal?: AbortSignal): Promise<VizBreaks> {
  const params = new URLSearchParams();
  return getJson<VizBreaks>(`/api/viz/breaks?${withFile(params).toString()}`, signal);
}

export async function fetchVizCounters(
  begin: number,
  end: number,
  query: string,
  buckets: number,
  signal?: AbortSignal,
): Promise<VizCounters> {
  const params = new URLSearchParams({
    begin: String(Math.floor(begin)),
    end: String(Math.ceil(end)),
    buckets: String(buckets),
  });
  if (query && query.trim()) params.set("query", query.trim());
  const res = await fetch(apiUrl(`/api/viz/counters.arrow?${withFile(params).toString()}`), {
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
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
  signal?: AbortSignal,
): Promise<CallTreeResponse> {
  const params = new URLSearchParams({
    begin: String(Math.floor(begin)),
    end: String(Math.ceil(end)),
  });
  if (query && query.trim()) params.set("query", query.trim());
  if (byProcess) params.set("group", "pid");
  return getJson<CallTreeResponse>(`/api/viz/calltree?${withFile(params).toString()}`, signal);
}

export function fetchHistogram(
  begin: number,
  end: number,
  query: string,
  signal?: AbortSignal,
): Promise<HistogramResponse> {
  const params = new URLSearchParams({
    begin: String(Math.floor(begin)),
    end: String(Math.ceil(end)),
  });
  if (query && query.trim()) params.set("query", query.trim());
  return getJson<HistogramResponse>(`/api/viz/histogram?${withFile(params).toString()}`, signal);
}

export function fetchVizStats(
  t0: number,
  t1: number,
  query: string,
  group?: string,
  signal?: AbortSignal,
): Promise<SelectionStats> {
  const params = new URLSearchParams({
    begin: String(Math.floor(t0)),
    end: String(Math.ceil(t1)),
  });
  if (query && query.trim()) params.set("query", query.trim());
  if (group) params.set("group", group);
  return getJson<SelectionStats>(`/api/viz/stats?${withFile(params).toString()}`, signal);
}

export interface LayersResponse {
  layers: Record<string, string>; // operation name -> category
  total_files: number; // files declared by FH metadata
  io_files: number; // files actually read from or written to
}

export function fetchLayers(signal?: AbortSignal): Promise<LayersResponse> {
  return getJson<LayersResponse>(
    `/api/viz/layers?${withFile(new URLSearchParams()).toString()}`,
    signal,
  );
}
