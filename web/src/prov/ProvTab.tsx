// Provenance tab: the temporal view, which follows a run while it grows, and the layered graph of a finished trace.
import { createSignal, lazy, Show, Suspense } from "solid-js";
import { ProvTimeline } from "./ProvTimeline";
import "./timeline.css";

const ProvenanceView = lazy(() =>
  import("./ProvenanceView").then((m) => ({ default: m.ProvenanceView })),
);

export function ProvTab(props: { mode: "dark" | "light"; scope: string }) {
  const [view, setView] = createSignal<"time" | "graph">("time");
  return (
    <div class="ptab">
      <div class="ptab-bar">
        <button classList={{ on: view() === "time" }} onClick={() => setView("time")}>
          Timeline
        </button>
        <button classList={{ on: view() === "graph" }} onClick={() => setView("graph")}>
          Graph
        </button>
      </div>
      <Show when={view() === "time"} fallback={<Suspense><ProvenanceView mode={props.mode} scope={props.scope} /></Suspense>}>
        <ProvTimeline scope={props.scope} />
      </Show>
    </div>
  );
}
