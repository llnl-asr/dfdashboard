// The key every provenance view draws in a corner: what each kind of vertex and edge means.
//
// Edges follow one rule in every view. A solid line is a relationship the trace recorded (an activity used, generated,
// updated or invalidated an entity, or an entity relation record). A dotted line is one the dashboard inferred: I/O
// matched to an activity by time, an entity matched to a file by its uri, an entity-to-entity flow through an
// activity, or an activity-to-activity link through an entity. The arrowhead points from cause to effect; an edge with
// no head has no direction. Inferred edges can be turned off, which every view honours.
import { For, Show } from "solid-js";

export type VertexShape = "ellipse" | "box" | "square" | "file" | "barrel" | "bar" | "dot" | "tag";

export interface LegendVertex {
  label: string;
  shape: VertexShape;
  color?: string; // fill; omitted for shapes drawn in the panel's own colors
  outline?: string;
}

export interface LegendEdge {
  label: string;
  inferred?: boolean;
  color?: string;
  arrow?: boolean; // false for an edge with no direction
  note?: string;
}

/** Inferred edges are drawn as a dotted line; recorded ones are solid. */
export const INFERRED_DASH = [2, 3];
export const INFERRED_DASH_SVG = "2 3";

function Swatch(props: { v: LegendVertex }) {
  const fill = () => props.v.color ?? "var(--panel)";
  const stroke = () => props.v.outline ?? (props.v.color ? "none" : "var(--text)");
  return (
    <svg class="plg-sw" width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      {(() => {
        switch (props.v.shape) {
          case "ellipse":
          case "dot":
            return (
              <circle
                cx="9"
                cy="7"
                r={props.v.shape === "dot" ? 3.5 : 5.5}
                fill={fill()}
                stroke={stroke()}
              />
            );
          case "box":
            return (
              <rect x="2" y="3" width="14" height="8" rx="2.5" fill={fill()} stroke={stroke()} />
            );
          case "square":
            return (
              <rect x="3" y="2" width="12" height="10" rx="2" fill={fill()} stroke={stroke()} />
            );
          case "file":
            return <rect x="5" y="1.5" width="8" height="11" fill={fill()} stroke={stroke()} />;
          case "barrel":
            return (
              <rect
                x="2"
                y="2"
                width="14"
                height="10"
                rx="4"
                ry="3"
                fill={fill()}
                stroke={stroke()}
              />
            );
          case "bar":
            return <rect x="1" y="4" width="16" height="6" fill={fill()} stroke={stroke()} />;
          case "tag":
            return (
              <rect
                x="3"
                y="3"
                width="12"
                height="8"
                rx="2"
                fill="var(--panel)"
                stroke={props.v.color ?? "var(--muted)"}
                stroke-dasharray="2 2"
              />
            );
        }
      })()}
    </svg>
  );
}

function Line(props: { e: LegendEdge; id: string }) {
  const color = () => props.e.color ?? "var(--muted)";
  return (
    <svg class="plg-sw wide" width="34" height="12" viewBox="0 0 34 12" aria-hidden="true">
      <defs>
        <marker
          id={props.id}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill={color()} />
        </marker>
      </defs>
      <line
        x1="2"
        y1="6"
        x2={props.e.arrow === false ? 32 : 28}
        y2="6"
        stroke={color()}
        stroke-width="1.6"
        stroke-dasharray={props.e.inferred ? INFERRED_DASH_SVG : undefined}
        marker-end={props.e.arrow === false ? undefined : `url(#${props.id})`}
      />
    </svg>
  );
}

let uid = 0;

// Whether the legend is open is a per-viewer convenience, kept across views and reloads when storage allows.
const OPEN_KEY = "dfdashboard.prov.legend.open";
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // storage blocked: the legend still works, it just forgets
  }
}

export function Legend(props: {
  vertices: LegendVertex[];
  edges: LegendEdge[];
  inferred: boolean;
  onInferred: (on: boolean) => void;
  types?: { name: string; color: string }[]; // entity types by color, where a view colors by type
  groups?: { title: string; items: { name: string; color: string }[] }[]; // further color keys
  extra?: string;
}) {
  const base = `plg${++uid}`;
  const hasInferred = () => props.edges.some((e) => e.inferred);
  return (
    <details
      class="plg"
      open={readOpen()}
      onToggle={(e) => writeOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Legend</summary>
      <Show when={props.vertices.length}>
        <h5>Vertices</h5>
        <For each={props.vertices}>
          {(v) => (
            <div class="plg-row">
              <Swatch v={v} />
              <span>{v.label}</span>
            </div>
          )}
        </For>
      </Show>
      <For
        each={[
          ...(props.types?.length ? [{ title: "Entity types (fill)", items: props.types }] : []),
          ...(props.groups ?? []).filter((g) => g.items.length),
        ]}
      >
        {(g) => (
          <>
            <h5>{g.title}</h5>
            <div class="plg-types">
              <For each={g.items}>
                {(t) => (
                  <span class="plg-type" title={t.name}>
                    <i style={{ background: t.color }} />
                    {t.name}
                  </span>
                )}
              </For>
            </div>
          </>
        )}
      </For>
      <h5>Edges</h5>
      <For each={props.edges}>
        {(e, i) => (
          <div
            class="plg-row"
            classList={{ off: !!e.inferred && !props.inferred }}
            title={e.note ?? ""}
          >
            <Line e={e} id={`${base}-${i()}`} />
            <span>
              {e.label}
              <Show when={e.inferred}>
                <span class="muted"> · inferred</span>
              </Show>
            </span>
          </div>
        )}
      </For>
      <p class="plg-note">
        Solid: recorded in the trace. Dotted: inferred by the dashboard. The arrow points from cause
        to effect.
        <Show when={props.extra}> {props.extra}</Show>
      </p>
      <Show when={hasInferred()}>
        <label class="plg-toggle">
          <input
            type="checkbox"
            checked={props.inferred}
            onChange={(e) => props.onInferred(e.currentTarget.checked)}
          />
          Show inferred edges
        </label>
      </Show>
    </details>
  );
}

/** The inferred-edge switch ProvTab shares with every view. */
export interface EdgeSwitch {
  inferred: () => boolean;
  setInferred: (on: boolean) => void;
}
