import { Show, createSignal, onMount, onCleanup, type JSX } from "solid-js";
import { apiUrl } from "../data/api";
import { consoleOpen, toggleConsole, unreadErrors } from "./consoleStore";

interface Runtime {
  cluster: { running: boolean; workers: number; address: string | null };
  tasks: { queued: number; running: number; done: number; failed: number };
}

// Static bottom bar for every view; `props.children` fills the view-specific
// status slot.
export function StatusBar(props: { children?: JSX.Element }) {
  const [rt, setRt] = createSignal<Runtime | null>(null);
  const [online, setOnline] = createSignal(true);

  const poll = async () => {
    try {
      setRt((await (await fetch(apiUrl("/api/runtime"))).json()) as Runtime);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  };
  onMount(() => {
    poll();
    const t = setInterval(poll, 3000);
    onCleanup(() => clearInterval(t));
  });

  const cluster = () => {
    const c = rt()?.cluster;
    if (!c || !c.running) return "cluster idle";
    if (c.address && c.address !== "local") return `cluster ${c.workers} workers`;
    return "cluster local";
  };
  const active = () => {
    const t = rt()?.tasks;
    return t ? t.running + t.queued : 0;
  };

  return (
    <footer class="statusbar">
      <span
        class="sb-online"
        classList={{ off: !online() }}
        title={online() ? "connected" : "offline"}
      >
        <span class="sb-dot" />
        {online() ? "online" : "offline"}
      </span>
      <div class="sb-status">{props.children}</div>
      <span class="sb-cluster" classList={{ on: !!rt()?.cluster.running }}>
        {cluster()}
      </span>
      <Show when={active() > 0}>
        <span class="sb-tasks">
          {rt()!.tasks.running} running
          <Show when={rt()!.tasks.queued > 0}> · {rt()!.tasks.queued} queued</Show>
        </span>
      </Show>
      <button
        type="button"
        class="sb-console"
        classList={{ active: consoleOpen() }}
        title="Toggle log console"
        onClick={toggleConsole}
      >
        <span class="sb-console-icon">{"{ }"}</span>
        <span>Console</span>
        <Show when={unreadErrors() > 0}>
          <span class="sb-badge">{unreadErrors() > 99 ? "99+" : unreadErrors()}</span>
        </Show>
      </button>
    </footer>
  );
}
