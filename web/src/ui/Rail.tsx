import { createSignal, For } from "solid-js";
import { A, useLocation, useSearchParams } from "@solidjs/router";

const STORE_KEY = "dfd.rail.collapsed";
const readCollapsed = () => {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};
// Shared across every Rail instance (App + Analysis) so the choice is global.
const [collapsed, setCollapsed] = createSignal(readCollapsed());
export const railCollapsed = collapsed;
function toggleRail() {
  const v = !collapsed();
  setCollapsed(v);
  try {
    localStorage.setItem(STORE_KEY, v ? "1" : "0");
  } catch {
    // no-op: private mode or storage disabled
  }
}

const ICON_OVERVIEW =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1.5" y="1.5" width="6" height="6" rx="1"/><rect x="8.5" y="1.5" width="6" height="4" rx="1"/><rect x="8.5" y="6.5" width="6" height="8" rx="1"/><rect x="1.5" y="8.5" width="6" height="6" rx="1"/></svg>';
const ICON_TIMELINE =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1.5" y="3" width="9" height="2.2" rx="1"/><rect x="1.5" y="6.9" width="13" height="2.2" rx="1"/><rect x="1.5" y="10.8" width="6" height="2.2" rx="1"/></svg>';
const ICON_FLAME =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="2" y="2.5" width="12" height="2.4" rx="1"/><rect x="2" y="6.3" width="8" height="2.4" rx="1"/><rect x="2" y="10.1" width="4" height="2.4" rx="1"/></svg>';
const ICON_SANDWICH =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="2" y="2.6" width="12" height="2.4" rx="1" opacity=".45"/><rect x="2" y="6.3" width="12" height="2.4" rx="1"/><rect x="2" y="10" width="12" height="2.4" rx="1" opacity=".45"/></svg>';
const ICON_PROV =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="3.5" cy="4" r="2"/><circle cx="3.5" cy="12" r="2"/><circle cx="12.5" cy="8" r="2"/><path d="M5.5 4.6 10.6 7.3M5.5 11.4 10.6 8.7"/></svg>';
const ICON_API =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/></svg>';
const ICON_ANALYSIS =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>';
const ICON_GEAR =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/></svg>';

export const TRACE_VIEWS = [
  "overview",
  "timeline",
  "flamegraph",
  "sandwich",
  "provenance",
  "prov-runtime",
  "prov-temporal",
  "prov-graph",
  "api",
] as const;
export type TraceView = (typeof TRACE_VIEWS)[number];

const VIEW_ITEMS: [TraceView, string, string][] = [
  ["overview", "Overview", ICON_OVERVIEW],
  ["timeline", "Timeline", ICON_TIMELINE],
  ["flamegraph", "Flamegraph", ICON_FLAME],
  ["sandwich", "Sandwich", ICON_SANDWICH],
];

// What a run does, when, and its graph over time and as a whole.
const PROV_ITEMS: [TraceView, string, string][] = [
  ["provenance", "Behaviors", ICON_PROV],
  ["prov-runtime", "Runtime", ICON_TIMELINE],
  ["prov-temporal", "Temporal graph", ICON_SANDWICH],
  ["prov-graph", "Knowledge graph", ICON_PROV],
];

// The one nav shell for every page. Trace views are query-param routes on "/"
// so they switch the app's view (no reload); Analysis is its own route.
export function Rail(props: { onSettings?: () => void; settingsActive?: boolean }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const onTrace = () => location.pathname === "/";
  const activeView = () => (params.view as TraceView | "analysis") || "overview";

  return (
    <nav class="leftnav" classList={{ collapsed: collapsed() }}>
      <div class="nav-top">
        <div class="brand" title="DFDashboard">
          <span class="brand-mark" />
          <span class="brand-text">DFDashboard</span>
        </div>
        <button
          type="button"
          class="nav-collapse"
          title={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleRail}
        >
          {collapsed() ? ">" : "<"}
        </button>
      </div>
      <div class="nav-views">
        <For each={VIEW_ITEMS}>
          {([id, label, icon]) => (
            <A
              href={`/?view=${id}`}
              class="nav-item"
              title={label}
              classList={{ active: onTrace() && activeView() === id }}
            >
              <span class="nav-icon" innerHTML={icon} />
              <span class="nav-label">{label}</span>
            </A>
          )}
        </For>
        <div class="nav-section">Provenance</div>
        <For each={PROV_ITEMS}>
          {([id, label, icon]) => (
            <A
              href={`/?view=${id}`}
              class="nav-item"
              title={label}
              classList={{ active: onTrace() && activeView() === id }}
            >
              <span class="nav-icon" innerHTML={icon} />
              <span class="nav-label">{label}</span>
            </A>
          )}
        </For>
        <A
          href="/?view=analysis"
          class="nav-item"
          title="Analysis"
          classList={{ active: onTrace() && activeView() === "analysis" }}
        >
          <span class="nav-icon" innerHTML={ICON_ANALYSIS} />
          <span class="nav-label">Analysis</span>
        </A>
      </div>
      <div class="nav-bottom">
        <A
          href="/?view=api"
          class="nav-item"
          title="API"
          classList={{ active: onTrace() && activeView() === "api" }}
        >
          <span class="nav-icon" innerHTML={ICON_API} />
          <span class="nav-label">API</span>
        </A>
        {props.onSettings && (
          <button
            type="button"
            class="nav-item"
            classList={{ active: props.settingsActive }}
            title="Settings"
            onClick={() => props.onSettings?.()}
          >
            <span class="nav-icon" innerHTML={ICON_GEAR} />
            <span class="nav-label">Settings</span>
          </button>
        )}
      </div>
    </nav>
  );
}
