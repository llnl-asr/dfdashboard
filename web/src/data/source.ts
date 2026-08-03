import { createContext, useContext, type Accessor } from "solid-js";

export interface Series {
  id: string;
  name: string;
  cat: string;
  key: string;
  family: string;
  values: number[];
  min: number;
  max: number;
  mean: number;
  last: number;
}
export interface Payload {
  begin: number;
  bucket_us: number;
  buckets: number;
  series: Series[];
}

export interface SplitEntity {
  entity: string;
  label: string;
  values: number[];
  min: number;
  max: number;
  mean: number;
  last: number;
  total: number;
}
export interface SplitPayload {
  begin: number;
  bucket_us: number;
  buckets: number;
  series_id: string;
  dim: string;
  family?: string;
  entities: SplitEntity[];
  total_entities: number;
  band?: { p10: number[]; p50: number[]; p90: number[] };
}

export interface NodeSeries {
  name: string;
  key: string;
  values: number[];
  counts?: number[]; // raw emissions folded into each bucket
  max: number;
}
export interface NodePayload {
  begin: number;
  bucket_us: number;
  buckets: number;
  hosts: { host: string; series: NodeSeries[] }[];
}

export interface Range {
  begin: number;
  end: number;
  width: number;
}
export interface SplitReq extends Range {
  series: string;
  dim: string;
  top: number;
}

// Transport-agnostic access to trace-derived data. Each method takes a reactive
// accessor of its request params (null = don't fetch) and returns a reactive
// accessor of the result. The SPA backs this with HTTP, the notebook widget
// with the Panel comm channel; the components never know which.
export interface TraceSource {
  supportsSplit: boolean;
  counterSeries(range: () => Range | null): Accessor<Payload | null>;
  counterSplit(req: () => SplitReq | null): Accessor<SplitPayload | null>;
  nodeCounters(range: () => Range | null): Accessor<NodePayload | null>;
}

export const TraceSourceContext = createContext<TraceSource>();

export function useTraceSource(): TraceSource {
  const s = useContext(TraceSourceContext);
  if (!s) throw new Error("TraceSourceContext not provided");
  return s;
}
