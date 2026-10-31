// The Provenance section of the rail: what a run does (behaviors), when (runtime), and its graph over time and as a whole.
import { lazy, Match, Show, Suspense, Switch } from "solid-js";
import type { RunInfo } from "../data/api";
import { createLiveProv } from "./live";
import { LiveBadge } from "./LiveBadge";
import { ProvTimeline } from "./ProvTimeline";
import "./prov.css";
import "./timeline.css";

const ProvenanceView = lazy(() =>
  import("./ProvenanceView").then((m) => ({ default: m.ProvenanceView })),
);
const TypeGraphView = lazy(() =>
  import("./TypeGraphView").then((m) => ({ default: m.TypeGraphView })),
);
const ProvRuntime = lazy(() => import("./ProvRuntime").then((m) => ({ default: m.ProvRuntime })));

export type ProvView = "provenance" | "prov-runtime" | "prov-temporal" | "prov-graph";

export function ProvTab(props: {
  view: ProvView;
  mode: "dark" | "light";
  scope: string;
  run?: RunInfo;
}) {
  // One live source for every view, so switching views loads nothing again.
  const live = createLiveProv(() => props.scope);
  return (
    <div class="ptab">
      <div class="ptab-head">
        <span class="prov-source" title={props.run?.dir ?? ""}>
          <b>Trace</b> {props.scope || "all runs"}
          <Show when={props.run}>
            {(r) => (
              <span class="muted">
                {" "}
                · {r().files} files · {r().state} · {r().dir}
              </span>
            )}
          </Show>
        </span>
        <LiveBadge live={live} />
      </div>
      <Switch>
        <Match when={props.view === "provenance"}>
          <Suspense>
            <TypeGraphView mode={props.mode} live={live} />
          </Suspense>
        </Match>
        <Match when={props.view === "prov-runtime"}>
          <Suspense>
            <ProvRuntime mode={props.mode} live={live} />
          </Suspense>
        </Match>
        <Match when={props.view === "prov-temporal"}>
          <ProvTimeline live={live} />
        </Match>
        <Match when={props.view === "prov-graph"}>
          <Suspense>
            <ProvenanceView mode={props.mode} scope={props.scope} live={live} />
          </Suspense>
        </Match>
      </Switch>
    </div>
  );
}
