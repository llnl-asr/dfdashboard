// The provenance of a run as a timeline: time runs top to bottom, the graph follows the run as it grows through
// /api/prov/stream, and the right bar describes what is selected.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  openProvStream,
  type ProvAccess,
  type ProvActivity,
  type ProvDelta,
  type ProvEntity,
  type ProvEntityRelation,
  type ProvGraphResponse,
  type ProvType,
} from "../data/api";
import { edgePath, entityLabel, type Graph, layout, leaf, type Placed, select } from "./temporal";

const PALETTE = [
  "#4e9fd6",
  "#e6a13c",
  "#5fb87a",
  "#d9675f",
  "#a07bd1",
  "#3fb5a8",
  "#d4c04a",
  "#e07fb3",
  "#7f9cc2",
  "#b8865a",
];
const ROW = 30;
const COL = 18;
const PAD = 16;
const OVERSCAN = 20;

const fmtTime = (us: number) =>
  us >= 1e6
    ? (us / 1e6).toFixed(2) + " s"
    : us >= 1e3
      ? (us / 1e3).toFixed(1) + " ms"
      : Math.round(us) + " µs";
const fmtBytes = (n: number) =>
  n >= 1 << 20
    ? (n / (1 << 20)).toFixed(1) + " MiB"
    : n >= 1024
      ? (n / 1024).toFixed(1) + " KiB"
      : n + " B";

export function ProvTimeline(props: { scope: string }) {
  const [activities, setActivities] = createSignal<ProvActivity[]>([]);
  const [entities, setEntities] = createSignal(new Map<string, ProvEntity>());
  const [types, setTypes] = createSignal(new Map<string, ProvType>());
  const [accesses, setAccesses] = createSignal<ProvAccess[]>([]);
  const [relations, setRelations] = createSignal<ProvEntityRelation[]>([]);
  const [ready, setReady] = createSignal(false);
  const [showActivities, setShowActivities] = createSignal(true);
  const [showIo, setShowIo] = createSignal(true);
  const [hiddenTypes, setHiddenTypes] = createSignal(new Set<string>());
  const [picked, setPicked] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal<Placed | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(800);
  let scroller!: HTMLDivElement;

  const load = (d: ProvGraphResponse) => {
    setActivities(d.activities ?? []);
    setEntities(new Map((d.entities ?? []).map((e) => [e.hash, e])));
    setTypes(new Map((d.types ?? []).map((t) => [t.name, t])));
    setAccesses(d.accesses ?? []);
    setRelations(d.entity_relations ?? []);
    setReady(true);
  };
  const apply = (items: ProvDelta[]) => {
    const acts: ProvActivity[] = [];
    const acc: ProvAccess[] = [];
    const rel: ProvEntityRelation[] = [];
    const ents = new Map(entities());
    const tys = new Map(types());
    for (const i of items) {
      if (i.kind === "activity") acts.push(i);
      else if (i.kind === "access") acc.push(i);
      else if (i.kind === "relation") rel.push(i);
      else if (i.kind === "entity") ents.set(i.hash, i);
      else tys.set(i.name, i);
    }
    setEntities(ents);
    setTypes(tys);
    if (acts.length) setActivities([...activities(), ...acts]);
    if (acc.length) setAccesses([...accesses(), ...acc]);
    if (rel.length) setRelations([...relations(), ...rel]);
  };
  createEffect(() => {
    setReady(false);
    const close = openProvStream(props.scope, load, apply);
    onCleanup(close);
  });

  const graph = createMemo<Graph>(() => ({
    activities: activities(),
    entities: entities(),
    accesses: accesses(),
    relations: relations(),
  }));
  const typeNames = createMemo(() =>
    [...new Set([...entities().values()].map((e) => e.type))].sort(),
  );
  const colorOf = createMemo(
    () => new Map(typeNames().map((t, i) => [t, PALETTE[i % PALETTE.length]])),
  );
  const placed = createMemo(() => {
    const s = select(graph(), {
      activities: showActivities(),
      io: showIo(),
      hiddenTypes: hiddenTypes(),
      picked: picked(),
    });
    return layout(s.nodes, s.edges);
  });
  const t0 = createMemo(() => activities().reduce((m, a) => Math.min(m, a.ts), Infinity));
  const x = (c: number) => PAD + c * COL;
  const y = (r: number) => PAD + r * ROW;
  const labelX = createMemo(() => x(Math.max(placed().columns, 1)) + 12);
  const firstRow = createMemo(() => Math.max(0, Math.floor(scrollTop() / ROW) - OVERSCAN));
  const lastRow = createMemo(() => Math.ceil((scrollTop() + height()) / ROW) + OVERSCAN);
  const visibleNodes = createMemo(() => placed().nodes.slice(firstRow(), lastRow()));
  const visibleEdges = createMemo(() =>
    placed().edges.filter(
      (e) =>
        Math.max(e.fromRow, e.toRow) >= firstRow() && Math.min(e.fromRow, e.toRow) <= lastRow(),
    ),
  );
  const neighbors = createMemo(() => {
    const s = selected();
    const ids = new Set<string>();
    if (s)
      for (const e of placed().edges)
        if (e.source === s.id || e.target === s.id) ids.add(e.source + ">" + e.target);
    return ids;
  });
  const byType = createMemo(() => {
    const m = new Map<string, ProvEntity[]>();
    for (const e of entities().values()) m.set(e.type, [...(m.get(e.type) ?? []), e]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
  const toggle = (set: Set<string>, keys: string[], on: boolean) => {
    const next = new Set(set);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    return next;
  };
  const measure = (el: HTMLDivElement) => {
    scroller = el;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  // Follow the newest events while the view is at the bottom, as a log does.
  createEffect(() => {
    const rows = placed().nodes.length;
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < ROW * 4)
      scroller.scrollTop = rows * ROW;
  });

  const activity = (aid: string) => activities().find((a) => a.aid === aid);
  const entityRow = (id: string) => {
    const e = entities().get(id);
    return (
      <li>
        <a onClick={() => goto("E:" + id)}>{e ? entityLabel(e) : id.slice(0, 10)}</a>
        <Show when={e}>
          <span class="muted"> {e!.type}</span>
        </Show>
      </li>
    );
  };
  const goto = (id: string) => {
    const n = placed().nodes.find((p) => p.id === id);
    if (n) {
      setSelected(n);
      scroller.scrollTop = Math.max(0, n.row * ROW - height() / 2);
    }
  };

  return (
    <div class="pt">
      <div class="pt-main">
        <div class="pt-controls">
          <details class="pt-pick">
            <summary>Entities: {picked().size ? picked().size + " selected" : "all"}</summary>
            <div class="pt-menu">
              <Show when={picked().size}>
                <a onClick={() => setPicked(new Set<string>())}>clear selection</a>
              </Show>
              <For each={byType()}>
                {([type, list]) => (
                  <details>
                    <summary>
                      <i class="pt-dot" style={{ background: colorOf().get(type) }} /> {type}{" "}
                      <span class="muted">{list.length}</span>
                    </summary>
                    <label class="muted">
                      <input
                        type="checkbox"
                        checked={list.every((e) => picked().has(e.hash))}
                        onChange={(ev) =>
                          setPicked(
                            toggle(
                              picked(),
                              list.map((e) => e.hash),
                              ev.currentTarget.checked,
                            ),
                          )
                        }
                      />
                      all {type}
                    </label>
                    <For each={list.slice(0, 500)}>
                      {(e) => (
                        <label>
                          <input
                            type="checkbox"
                            checked={picked().has(e.hash)}
                            onChange={(ev) =>
                              setPicked(toggle(picked(), [e.hash], ev.currentTarget.checked))
                            }
                          />
                          {entityLabel(e)}
                        </label>
                      )}
                    </For>
                  </details>
                )}
              </For>
            </div>
          </details>
          <span class="muted">Show</span>
          <label class="pt-chip">
            <input
              type="checkbox"
              checked={showActivities()}
              onChange={(e) => setShowActivities(e.currentTarget.checked)}
            />{" "}
            Activities
          </label>
          <label class="pt-chip">
            <input
              type="checkbox"
              checked={showIo()}
              onChange={(e) => setShowIo(e.currentTarget.checked)}
            />{" "}
            I/O
          </label>
          <For each={typeNames()}>
            {(t) => (
              <label class="pt-chip">
                <input
                  type="checkbox"
                  checked={!hiddenTypes().has(t)}
                  onChange={(e) =>
                    setHiddenTypes(toggle(hiddenTypes(), [t], !e.currentTarget.checked))
                  }
                />
                <i class="pt-dot" style={{ background: colorOf().get(t) }} /> {t}
              </label>
            )}
          </For>
        </div>
        <div
          class="pt-scroll"
          ref={measure}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <Show
            when={ready() && placed().nodes.length}
            fallback={
              <div class="muted pt-empty">
                {ready() ? "No provenance records yet." : "Connecting…"}
              </div>
            }
          >
            <svg class="pt-svg" width="100%" height={placed().nodes.length * ROW + PAD * 2}>
              <For each={visibleEdges()}>
                {(e) => (
                  <path
                    class={`pt-edge ${e.kind}`}
                    classList={{ hi: neighbors().has(e.source + ">" + e.target) }}
                    d={edgePath(e, x, y)}
                  />
                )}
              </For>
              <For each={visibleNodes()}>
                {(n) => (
                  <g
                    class="pt-node"
                    classList={{ on: selected()?.id === n.id }}
                    onClick={() => setSelected(n)}
                  >
                    <rect class="pt-hit" x={0} y={y(n.row) - ROW / 2} width="100%" height={ROW} />
                    <line
                      class="pt-lead"
                      x1={x(n.col) + 8}
                      y1={y(n.row)}
                      x2={labelX() - 4}
                      y2={y(n.row)}
                    />
                    <Show
                      when={n.kind === "entity"}
                      fallback={
                        n.kind === "activity" ? (
                          <rect
                            class="pt-act"
                            x={x(n.col) - 7}
                            y={y(n.row) - 6}
                            width={14}
                            height={12}
                            rx={3}
                          />
                        ) : (
                          <rect
                            class="pt-file"
                            x={x(n.col) - 5}
                            y={y(n.row) - 6}
                            width={10}
                            height={12}
                          />
                        )
                      }
                    >
                      <circle
                        cx={x(n.col)}
                        cy={y(n.row)}
                        r={6.5}
                        fill={colorOf().get(n.type ?? "") ?? "#888"}
                      />
                    </Show>
                    <text class={`pt-label ${n.kind}`} x={labelX()} y={y(n.row) + 4}>
                      {n.label}
                    </text>
                    <text class="pt-when" x="100%" dx={-10} y={y(n.row) + 4} text-anchor="end">
                      {fmtTime(Math.max(0, n.t - t0()))}
                    </text>
                  </g>
                )}
              </For>
            </svg>
          </Show>
        </div>
      </div>
      <aside class="pt-side">
        <Show
          when={selected()}
          fallback={
            <>
              <h3>Run</h3>
              <dl>
                <dt>Activities</dt>
                <dd>{activities().length.toLocaleString()}</dd>
                <dt>Entities</dt>
                <dd>{entities().size.toLocaleString()}</dd>
                <dt>Entity types</dt>
                <dd>{typeNames().length}</dd>
                <dt>Files with I/O</dt>
                <dd>{new Set(accesses().map((a) => a.path)).size}</dd>
              </dl>
              <p class="muted">Select an event for its details.</p>
            </>
          }
        >
          {(s) => (
            <>
              <Show when={s().kind === "activity" && activity(s().ref)}>
                {(a) => (
                  <>
                    <h3>Activity</h3>
                    <div class="pt-name">{a().name}</div>
                    <dl>
                      <dt>Started</dt>
                      <dd>{fmtTime(a().ts - t0())}</dd>
                      <dt>Duration</dt>
                      <dd>{fmtTime(a().dur)}</dd>
                      <dt>Process</dt>
                      <dd>{a().pid}</dd>
                    </dl>
                    <Show when={a().used.length}>
                      <h4>Used</h4>
                      <ul>
                        <For each={a().used}>{entityRow}</For>
                      </ul>
                    </Show>
                    <Show when={a().generated.length}>
                      <h4>Generated</h4>
                      <ul>
                        <For each={a().generated}>{entityRow}</For>
                      </ul>
                    </Show>
                    <Show when={accesses().some((x) => x.aid === a().aid)}>
                      <h4>I/O</h4>
                      <ul>
                        <For each={accesses().filter((x) => x.aid === a().aid)}>
                          {(x) => (
                            <li>
                              <span class="muted">{x.op}</span> {leaf(x.path)}{" "}
                              <span class="muted">
                                {x.calls}× {x.bytes ? fmtBytes(x.bytes) : ""}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={s().kind === "entity" && entities().get(s().ref)}>
                {(e) => (
                  <>
                    <h3>Entity</h3>
                    <div class="pt-name">{entityLabel(e())}</div>
                    <dl>
                      <dt>Type</dt>
                      <dd>{e().type}</dd>
                      <dt>Role</dt>
                      <dd>{types().get(e().type)?.role ?? "unknown"}</dd>
                      <dt>Store</dt>
                      <dd>{e().store}</dd>
                    </dl>
                    <Show when={types().get(e().type)?.description}>
                      <p class="muted">{types().get(e().type)!.description}</p>
                    </Show>
                    <Show when={e().uri}>
                      <h4>URI</h4>
                      <code>{e().uri}</code>
                    </Show>
                    <h4>Id</h4>
                    <code>{e().id}</code>
                    <Show when={activities().some((a) => a.generated.includes(e().hash))}>
                      <h4>Made by</h4>
                      <ul>
                        <For each={activities().filter((a) => a.generated.includes(e().hash))}>
                          {(a) => (
                            <li>
                              <a onClick={() => goto("A:" + a.aid)}>{a.name}</a>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={activities().some((a) => a.used.includes(e().hash))}>
                      <h4>Used by</h4>
                      <ul>
                        <For each={activities().filter((a) => a.used.includes(e().hash))}>
                          {(a) => (
                            <li>
                              <a onClick={() => goto("A:" + a.aid)}>{a.name}</a>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={s().kind === "file"}>
                <h3>File</h3>
                <div class="pt-name">{leaf(s().ref)}</div>
                <code>{s().ref}</code>
                <h4>Accessed by</h4>
                <ul>
                  <For each={accesses().filter((x) => x.path === s().ref)}>
                    {(x) => (
                      <li>
                        <a onClick={() => goto("A:" + x.aid)}>{activity(x.aid)?.name ?? x.aid}</a>{" "}
                        <span class="muted">
                          {x.op} {x.calls}×
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </>
          )}
        </Show>
      </aside>
    </div>
  );
}
