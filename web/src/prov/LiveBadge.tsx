// Says what the data on screen is: new data is coming in and being processed, or it is up to date.
import { Match, Switch } from "solid-js";
import type { LiveProv } from "./live";

const at = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : "");

export function LiveBadge(props: { live: LiveProv }) {
  const l = () => props.live;
  return (
    <span
      class="prov-live"
      classList={{ busy: l().state() !== "idle" }}
      role="status"
      aria-live="polite"
    >
      <i />
      <Switch fallback={`Live · up to date at ${at(l().updated())}`}>
        <Match when={l().state() === "connecting"}>Connecting…</Match>
        <Match when={l().state() === "reconnecting"}>Connection lost, reconnecting…</Match>
        <Match when={l().state() === "reading"}>New data · reading the trace…</Match>
        <Match when={l().state() === "receiving"}>
          New data · {l().pending().toLocaleString()} records waiting
        </Match>
        <Match when={l().state() === "processing"}>New data · updating…</Match>
      </Switch>
    </span>
  );
}
