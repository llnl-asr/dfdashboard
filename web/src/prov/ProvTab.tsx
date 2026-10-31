// Provenance tab: the temporal view, which follows a run while it grows, how entity types relate, and the layered graph of a finished trace.
import { createSignal, lazy, Match, Suspense, Switch } from "solid-js";
import { ProvTimeline } from "./ProvTimeline";
import "./timeline.css";

const ProvenanceView = lazy(() =>
  import("./ProvenanceView").then((m) => ({ default: m.ProvenanceView })),
);

const TypeGraphView = lazy(() =>
  import("./TypeGraphView").then((m) => ({ default: m.TypeGraphView })),
);

export function ProvTab(props: { mode: "dark" | "light"; scope: string }) {
  const [view, setView] = createSignal<"time" | "types" | "graph">("time");
  return (
    <div class="ptab">
      <div class="ptab-bar">
        <button classList={{ on: view() === "time" }} onClick={() => setView("time")}>
          Timeline
        </button>
        <button classList={{ on: view() === "types" }} onClick={() => setView("types")}>
          Types
        </button>
        <button classList={{ on: view() === "graph" }} onClick={() => setView("graph")}>
          Graph
        </button>
      </div>
      <Switch>
        <Match when={view() === "time"}>
          <ProvTimeline scope={props.scope} />
        </Match>
        <Match when={view() === "types"}>
          <Suspense>
            <TypeGraphView mode={props.mode} scope={props.scope} />
          </Suspense>
        </Match>
        <Match when={view() === "graph"}>
          <Suspense>
            <ProvenanceView mode={props.mode} scope={props.scope} />
          </Suspense>
        </Match>
      </Switch>
    </div>
  );
}
