// Provenance tab: how entity types relate, derived from the instances a trace saw. A type expands
// into its instances, so the high-level picture opens up where it is interesting.
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { ProvEntity } from "../data/api";
import type { LiveProv } from "./live";
import {
  behaviors,
  FLOW,
  overview,
  type Tally,
  type TypeGraph,
  typeGraph,
  type TypeView,
  type VEdge,
  type VNode,
  view,
} from "./typegraph";
import "./prov.css";

cytoscape.use(dagre);

const INSTANCE_STEP = 30;
const LABEL_FONT = 11;
const MIN_NODE = 34;
const MAX_NODE = 90;
const NODE_PER_LOG = 12;
const MAX_EDGE = 6;

const ROLE_ORDER: Record<string, number> = { input: 0, intermediate: 1, output: 2 };
const nodeSize = (n: number) =>
  Math.min(MAX_NODE, MIN_NODE + NODE_PER_LOG * Math.log10(Math.max(n, 1)));
const edgeWidth = (n: number) => Math.min(MAX_EDGE, 1 + Math.log10(Math.max(n, 1)));

const fmtTime = (us: number) =>
  us >= 60e6
    ? `${(us / 60e6).toFixed(1)} min`
    : us >= 1e6
      ? `${(us / 1e6).toFixed(1)} s`
      : `${(us / 1e3).toFixed(0)} ms`;
const BAR_ROWS = 10;

function Bars(props: { title: string; rows: Tally; fmt?: (n: number) => string }) {
  const top = () => Math.max(...props.rows.map((r) => r[1]), 1);
  return (
    <figure class="prov-chart">
      <figcaption>{props.title}</figcaption>
      <For each={props.rows.slice(0, BAR_ROWS)}>
        {([name, n]) => (
          <div class="bar" title={`${name}: ${n}`}>
            <span class="nm">{name}</span>
            <span class="tr">
              <i style={{ width: `${(n / top()) * 100}%` }} />
            </span>
            <span class="ct">{props.fmt ? props.fmt(n) : n.toLocaleString()}</span>
          </div>
        )}
      </For>
      <Show when={props.rows.length > BAR_ROWS}>
        <div class="more">{props.rows.length - BAR_ROWS} more</div>
      </Show>
    </figure>
  );
}

function Columns(props: { title: string; note: string; rows: Tally }) {
  const top = () => Math.max(...props.rows.map((r) => r[1]), 1);
  return (
    <figure class="prov-chart">
      <figcaption>{props.title}</figcaption>
      <div class="cols">
        <For each={props.rows}>
          {([name, n]) => (
            <span class="col" title={`${name}: ${n}`}>
              <i style={{ height: `${(n / top()) * 100}%` }} />
            </span>
          )}
        </For>
      </div>
      <div class="more">{props.note}</div>
    </figure>
  );
}

const nodeText = (n: VNode) =>
  n.kind === "type" || n.kind === "group" ? `${n.label}\n${n.count.toLocaleString()}` : n.label;

type Picked =
  | { kind: "type"; name: string }
  | { kind: "edge"; edge: VEdge }
  | { kind: "entity"; entity: ProvEntity };

export function TypeGraphView(props: { mode: "dark" | "light"; live: LiveProv }) {
  let host!: HTMLDivElement;
  let cy: cytoscape.Core | undefined;
  let drawn = "";
  const data = () => props.live.data();
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [limits, setLimits] = createSignal<Map<string, number>>(new Map());
  const [picked, setPicked] = createSignal<Picked | null>(null);
  const [relations, setRelations] = createSignal(true);
  const [names, setNames] = createSignal(false);
  const graph = createMemo<TypeGraph | null>(() => {
    const d = data();
    return d ? typeGraph(d) : null;
  });
  const seenBehaviors = createMemo(() => {
    const g = graph();
    const d = data();
    return g && d ? behaviors(g, d.activities) : [];
  });
  const numbers = createMemo(() => {
    const g = graph();
    const d = data();
    return g && d ? overview(g, d) : null;
  });
  const rows = createMemo(() =>
    [...(graph()?.types.values() ?? [])].sort(
      (a, b) =>
        (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || a.name.localeCompare(b.name),
    ),
  );
  const current = createMemo(() => {
    const g = graph();
    if (!g) return null;
    const v = view(g, expanded(), (t) => limits().get(t) ?? INSTANCE_STEP);
    return relations() ? v : { ...v, edges: v.edges.filter((e) => e.kind === FLOW) };
  });
  const related = (name: string, side: "source" | "target") => {
    const out = new Map<string, number>();
    const g = graph();
    if (!g) return [];
    const [from, to] =
      side === "source" ? (["target", "source"] as const) : (["source", "target"] as const);
    for (const l of g.links) {
      if (g.type.get(l[from]) === name && l.kind === FLOW) {
        const t = g.type.get(l[to])!;
        if (t !== name) out.set(t, (out.get(t) ?? 0) + 1);
      }
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  };

  function toggle(name: string) {
    const next = new Set(expanded());
    if (!next.delete(name)) next.add(name);
    setExpanded(next);
  }

  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function style(): cytoscape.Stylesheet[] {
    const text = css("--text") || "#d6d3c0";
    const muted = css("--muted") || "#8a927c";
    const panel = css("--elev") || "#12140f";
    const accent = css("--accent") || "#e6a13c";
    const label = {
      color: text,
      "font-size": LABEL_FONT,
      "font-family": "ui-monospace, Menlo, monospace",
    };
    return [
      {
        selector: 'node[kind="type"]',
        style: {
          ...label,
          shape: "round-rectangle",
          "background-color": "data(color)",
          "background-opacity": 0.85,
          width: "data(size)",
          height: "data(size)",
          label: "data(text)",
          "text-valign": "bottom",
          "text-margin-y": 4,
          "text-wrap": "wrap",
          "text-max-width": "170px",
        },
      },
      {
        selector: 'node[kind="group"]',
        style: {
          ...label,
          shape: "round-rectangle",
          "background-color": "data(color)",
          "background-opacity": 0.08,
          "border-width": 1.5,
          "border-color": "data(color)",
          label: "data(text)",
          "text-valign": "top",
          "text-margin-y": -4,
          ...({ padding: "12px" } as object),
        },
      },
      {
        selector: 'node[kind="entity"]',
        style: {
          ...label,
          "font-size": 9,
          shape: "ellipse",
          "background-color": "data(color)",
          width: 16,
          height: 16,
          label: "data(text)",
          "text-valign": "bottom",
          "text-max-width": "110px",
          "text-wrap": "ellipsis",
        },
      },
      {
        selector: 'node[kind="more"]',
        style: {
          ...label,
          "font-size": 9,
          shape: "round-tag",
          color: muted,
          "background-color": panel,
          "border-width": 1,
          "border-style": "dashed",
          "border-color": "data(color)",
          width: 16,
          height: 16,
          label: "data(text)",
          "text-valign": "bottom",
        },
      },
      {
        selector: "edge",
        style: {
          ...label,
          "font-size": 9,
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.8,
          width: "data(width)",
          "line-color": muted,
          "target-arrow-color": muted,
          color: muted,
          "text-rotation": "autorotate",
          "text-background-color": panel,
          "text-background-opacity": 0.8,
          "text-background-padding": "1px",
        },
      },
      {
        selector: `edge[kind!="${FLOW}"]`,
        style: {
          "line-style": "dashed",
          "line-color": accent,
          "target-arrow-color": accent,
          color: accent,
        },
      },
      { selector: "edge.named", style: { label: "data(label)" } },
      { selector: ".faded", style: { opacity: 0.1 } },
      {
        selector: ":selected",
        style: {
          "border-width": 2,
          "border-color": accent,
          "line-color": accent,
          "target-arrow-color": accent,
        },
      },
    ];
  }

  /** Bring one element and what touches it forward; nothing given clears it, back to what is picked. */
  function focus(ele?: cytoscape.SingularElementReturnValue) {
    if (!cy) return;
    cy.elements().removeClass("faded");
    cy.edges().toggleClass("named", names());
    const target = ele ?? cy.$(":selected").first();
    if (!target.nonempty()) return;
    const near = target.isNode()
      ? target.union(target.descendants()).closedNeighborhood()
      : target.union(target.connectedNodes());
    const shown = near.union(near.nodes().ancestors()).union(near.nodes().descendants());
    cy.elements().not(shown).addClass("faded");
    near.edges().addClass("named");
  }

  /** New counts keep the picture where it is; only a new type or relationship moves things. */
  function refresh(v: TypeView): boolean {
    if (!cy) return false;
    const shape = [...v.nodes.map((n) => n.id), ...v.edges.map((e) => e.id)].sort().join("\0");
    if (shape !== drawn) {
      drawn = shape;
      return false;
    }
    cy.batch(() => {
      for (const n of v.nodes)
        cy!.getElementById(n.id).data({ text: nodeText(n), size: nodeSize(n.count) });
      for (const e of v.edges)
        cy!.getElementById(e.id).data({ label: e.label, width: edgeWidth(e.links) });
    });
    return true;
  }

  function draw() {
    const v = current();
    const g = graph();
    if (!v || !g || refresh(v)) return;
    cy?.destroy();
    cy = cytoscape({
      container: host,
      style: style(),
      wheelSensitivity: 0.25,
      elements: [
        ...v.nodes.map((n) => ({
          data: {
            id: n.id,
            parent: n.parent,
            kind: n.kind,
            type: n.type,
            color: g.types.get(n.type)!.color,
            size: nodeSize(n.count),
            text: nodeText(n),
          },
        })),
        ...v.edges.map((e) => ({
          data: {
            id: e.id,
            source: e.source,
            target: e.target,
            kind: e.kind,
            label: e.label,
            width: edgeWidth(e.links),
          },
        })),
      ],
    });
    // Relations point any way, so only data flow decides the left-to-right order.
    cy.elements()
      .not(`edge[kind!="${FLOW}"]`)
      .layout({
        name: "dagre",
        rankDir: "LR",
        nodeSep: 30,
        rankSep: 90,
        animate: false,
      } as cytoscape.LayoutOptions)
      .run();
    cy.fit(undefined, 30);
    focus();
    cy.on("mouseover", "node, edge", (ev) => focus(ev.target));
    cy.on("mouseout", "node, edge", () => focus());
    cy.on("select unselect", () => focus());
    cy.on("tap", "node", (ev) => {
      const n = current()!.nodes.find((x) => x.id === ev.target.id())!;
      if (n.kind === "more") {
        setLimits(
          new Map(limits()).set(n.type, (limits().get(n.type) ?? INSTANCE_STEP) + INSTANCE_STEP),
        );
      } else {
        setPicked(n.entity ? { kind: "entity", entity: n.entity } : { kind: "type", name: n.type });
      }
    });
    cy.on("tap", "edge", (ev) =>
      setPicked({ kind: "edge", edge: current()!.edges.find((e) => e.id === ev.target.id())! }),
    );
    cy.on("dbltap", 'node[kind="type"], node[kind="group"]', (ev) =>
      toggle(ev.target.data("type")),
    );
    cy.on("tap", (ev) => {
      if (ev.target === cy) setPicked(null);
    });
  }

  onMount(() => {
    createEffect(
      on(
        () => data() === null,
        (waiting) => {
          if (!waiting) return;
          setExpanded(new Set<string>());
          setPicked(null);
        },
      ),
    );
    createEffect(on(current, draw));
    createEffect(on(names, () => focus(), { defer: true }));
    createEffect(
      on(
        () => props.mode,
        () => cy?.style(style()),
        { defer: true },
      ),
    );
  });
  onCleanup(() => cy?.destroy());

  const edgeName = (id: string) => id.replace(/^[TEM]:/, "");
  const typeOf = () => {
    const p = picked();
    return p?.kind === "type" ? (graph()?.types.get(p.name) ?? null) : null;
  };

  return (
    <div class="prov">
      <aside class="prov-rail">
        <Show when={!data()}>
          <div class="muted">Scanning trace for provenance records…</div>
        </Show>
        <Show when={data()}>
          <Show when={graph()?.dangling}>
            <div class="prov-error">{graph()?.dangling} hashes have no entity record.</div>
          </Show>
          <section>
            <h3>Show</h3>
            <label class="prov-type">
              <input
                type="checkbox"
                checked={relations()}
                onChange={(e) => setRelations(e.currentTarget.checked)}
              />
              entity relations
            </label>
            <label class="prov-type">
              <input
                type="checkbox"
                checked={names()}
                onChange={(e) => setNames(e.currentTarget.checked)}
              />
              activity names
            </label>
            <div class="prov-row">
              <button onClick={() => setExpanded(new Set<string>())} disabled={!expanded().size}>
                Collapse all
              </button>
            </div>
          </section>
          <section>
            <h3>What each activity does</h3>
            <For each={seenBehaviors()}>
              {(b) => {
                const some = [...b.sometimes.uses, ...b.sometimes.makes];
                return (
                  <div class="prov-beh">
                    <b>{b.name}</b> ×{b.count}
                    <Show when={b.always.uses.length}>
                      <div class="sub">always uses {b.always.uses.join(", ")}</div>
                    </Show>
                    <Show when={b.always.makes.length}>
                      <div class="sub">always makes {b.always.makes.join(", ")}</div>
                    </Show>
                    <Show when={some.length}>
                      <div class="sub">
                        sometimes {some.map(([t, n]) => `${t} ${n}/${b.count}`).join(", ")}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </section>
          <section>
            <h3>Expand a type</h3>
            <For each={rows()}>
              {(t) => (
                <label class="prov-type" title={t.description || "no description recorded"}>
                  <input
                    type="checkbox"
                    checked={expanded().has(t.name)}
                    onChange={() => toggle(t.name)}
                  />
                  <span class="sw" style={{ background: t.color }} />
                  <span>{t.name}</span>
                  <span class="ct">{t.instances.length}</span>
                </label>
              )}
            </For>
          </section>
        </Show>
      </aside>
      <div class="prov-beh-main">
        <Show when={numbers()}>
          {(n) => (
            <div class="prov-tiles">
              <For
                each={
                  [
                    ["entity types", rows().length],
                    ["entities", data()!.entities.length],
                    ["activities", data()!.activities.length],
                    ["kinds of activity", n().activityKinds],
                    ["processes", n().processes],
                    ["longest chain", n().depth],
                    ["root entities", n().roots],
                    ["never used", n().leaves],
                  ] as [string, number][]
                }
              >
                {([label, value]) => (
                  <div class="tile">
                    <b>{value.toLocaleString()}</b>
                    <span>{label}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="prov-canvas">
          <div
            ref={host}
            class="prov-cy"
            role="img"
            aria-label="Relationships between entity types"
          />
          <Show when={picked()}>
            {(p) => (
              <div class="prov-detail">
                <Show when={typeOf()}>
                  {(t) => (
                    <>
                      <b>{t().name}</b>
                      <div class="muted">
                        {t().role || "no role"} · {t().instances.length} instances
                      </div>
                      <Show when={t().description}>
                        <p>{t().description}</p>
                      </Show>
                      <Show when={related(t().name, "source").length}>
                        <h4>Made from</h4>
                        <For each={related(t().name, "source")}>
                          {([n, c]) => (
                            <div>
                              {n} ({c})
                            </div>
                          )}
                        </For>
                      </Show>
                      <Show when={related(t().name, "target").length}>
                        <h4>Feeds</h4>
                        <For each={related(t().name, "target")}>
                          {([n, c]) => (
                            <div>
                              {n} ({c})
                            </div>
                          )}
                        </For>
                      </Show>
                      <button onClick={() => toggle(t().name)}>
                        {expanded().has(t().name) ? "Collapse" : "Expand instances"}
                      </button>
                    </>
                  )}
                </Show>
                <Show when={p().kind === "edge" && (p() as { edge: VEdge }).edge}>
                  {(e) => (
                    <>
                      <b>
                        {edgeName(e().source)} → {edgeName(e().target)}
                      </b>
                      <div class="muted">
                        {e().kind === FLOW ? "data flow" : e().kind} · {e().links} instance links
                      </div>
                      <For each={e().via}>
                        {([n, c]) => (
                          <div>
                            {n} ({c})
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </Show>
                <Show when={p().kind === "entity" && (p() as { entity: ProvEntity }).entity}>
                  {(x) => (
                    <>
                      <b>{x().type}</b>
                      <div class="muted">{x().id}</div>
                      <div>{x().uri || "no uri"}</div>
                      <div class="muted">{x().store}</div>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <div class="prov-hint">
            {data() && !data()!.entities.length
              ? "This trace has no provenance entities."
              : "Double-click a type to expand its instances. Point at a type or edge to follow it; click for details."}
          </div>
        </div>
        <Show when={numbers()}>
          {(n) => (
            <div class="prov-charts">
              <Bars title="Entities by type" rows={n().byType} />
              <Bars title="Entities by store" rows={n().byStore} />
              <Bars title="Entities by role" rows={n().byRole} />
              <Bars title="Runs of each activity" rows={n().activityRuns} />
              <Bars title="Time in each activity" rows={n().activityTime} fmt={fmtTime} />
              <Columns
                title="How often an entity is used"
                note="left to right: 0, 1, 2, 3-5, 6-20, 21+ uses"
                rows={n().reuse}
              />
              <Columns
                title="Entities made over the run"
                note={`left to right across ${fmtTime(n().span)}`}
                rows={n().created.map((c, i): [string, number] => [`slice ${i + 1}`, c])}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
