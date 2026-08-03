import { createResource, type Accessor } from "solid-js";
import { apiUrl } from "./api";
import type { NodePayload, Payload, Range, SplitPayload, SplitReq, TraceSource } from "./source";

const rangeParams = (r: Range) =>
  new URLSearchParams({
    begin: String(Math.round(r.begin)),
    end: String(Math.round(r.end)),
    width: String(r.width),
  });

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  return r.json() as Promise<T>;
}

// SPA transport: on-demand HTTP fetch; only the latest result is kept, so
// pan/zoom supersedes stale in-flight requests.
export function createHttpSource(): TraceSource {
  return {
    supportsSplit: true,

    counterSeries(range: () => Range | null): Accessor<Payload | null> {
      const [res] = createResource(range, (r) =>
        getJson<Payload>(`/api/viz/counters/series?${rangeParams(r)}`),
      );
      return () => res() ?? null;
    },

    counterSplit(req: () => SplitReq | null): Accessor<SplitPayload | null> {
      const [res] = createResource(req, (r) => {
        const p = rangeParams(r);
        p.set("series", r.series);
        p.set("dim", r.dim);
        p.set("top", String(r.top));
        return getJson<SplitPayload>(`/api/viz/counters/split?${p}`);
      });
      return () => res() ?? null;
    },

    nodeCounters(range: () => Range | null): Accessor<NodePayload | null> {
      const [res] = createResource(range, (r) =>
        getJson<NodePayload>(`/api/viz/counters/nodes?${rangeParams(r)}`),
      );
      return () => res() ?? null;
    },
  };
}
