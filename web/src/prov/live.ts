// The provenance of a run as it grows. The service watches the trace and pushes changes; here they wait in a buffer and
// are applied in batches, so the page stays usable and always shows the last complete picture while new data is processed.
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { openProvStream, type ProvDelta, type ProvGraphResponse } from "../data/api";

const MIN_BATCH_MS = 1000;
const BATCH_COST_FACTOR = 4; // wait at least this many times what the last batch took, so a slow page is never saturated

export type LiveState =
  "connecting" | "reading" | "receiving" | "processing" | "idle" | "reconnecting";

export interface LiveProv {
  data: Accessor<ProvGraphResponse | null>;
  state: Accessor<LiveState>;
  pending: Accessor<number>; // records received and not shown yet
  updated: Accessor<number | null>; // when the picture last changed, ms since the epoch
}

const empty = (g: Partial<ProvGraphResponse>): ProvGraphResponse =>
  ({
    ...g,
    entities: g.entities ?? [],
    activities: g.activities ?? [],
    types: g.types ?? [],
    entity_relations: g.entity_relations ?? [],
    accesses: g.accesses ?? [],
  }) as ProvGraphResponse;

/** The graph with these changes applied: a record seen again replaces the earlier one. Never changes its argument. */
export function applyDeltas(g: ProvGraphResponse, items: ProvDelta[]): ProvGraphResponse {
  const entities = new Map(g.entities.map((e) => [e.hash, e] as const));
  const activities = new Map(g.activities.map((a) => [a.aid, a] as const));
  const types = new Map((g.types ?? []).map((t) => [t.name, t] as const));
  const relations = (g.entity_relations ?? []).slice();
  const accesses = (g.accesses ?? []).slice();
  for (const { kind: _kind, ...i } of items as (ProvDelta & Record<string, never>)[]) {
    const r = i as never;
    if (_kind === "entity") entities.set((r as { hash: string }).hash, r);
    else if (_kind === "activity") activities.set((r as { aid: string }).aid, r);
    else if (_kind === "type") types.set((r as { name: string }).name, r);
    else if (_kind === "relation") relations.push(r);
    else accesses.push(r);
  }
  return {
    ...g,
    entities: [...entities.values()],
    activities: [...activities.values()],
    types: [...types.values()],
    entity_relations: relations,
    accesses,
  };
}

export function createLiveProv(scope: Accessor<string>): LiveProv {
  const [data, setData] = createSignal<ProvGraphResponse | null>(null);
  const [state, setState] = createSignal<LiveState>("connecting");
  const [pending, setPending] = createSignal(0);
  const [updated, setUpdated] = createSignal<number | null>(null);

  createEffect(() => {
    let buffer: ProvDelta[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = MIN_BATCH_MS;
    setData(null);
    setState("connecting");
    setPending(0);
    const flush = () => {
      timer = undefined;
      const items = buffer;
      buffer = [];
      setState("processing");
      // Let the badge paint before the work, so it says what is happening while it happens.
      requestAnimationFrame(() =>
        setTimeout(() => {
          const t0 = performance.now();
          const g = data();
          if (g) setData(applyDeltas(g, items));
          wait = Math.max(MIN_BATCH_MS, (performance.now() - t0) * BATCH_COST_FACTOR);
          setPending(buffer.length);
          setUpdated(Date.now());
          if (buffer.length) schedule();
          setState(buffer.length ? "receiving" : "idle");
        }),
      );
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(flush, wait);
    };
    const close = openProvStream(
      scope(),
      (g) => {
        buffer = [];
        setData(empty(g));
        setPending(0);
        setUpdated(Date.now());
        setState("idle");
      },
      (items) => {
        buffer.push(...items);
        setPending(buffer.length);
        setState("receiving");
        schedule();
      },
      () => setState("reconnecting"),
      () => setState("reading"),
    );
    onCleanup(() => {
      close();
      clearTimeout(timer);
    });
  });
  return { data, state, pending, updated };
}
