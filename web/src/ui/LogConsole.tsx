import { createSignal, createEffect, onCleanup, For, Show, batch } from "solid-js";
import { apiUrl } from "../data/api";
import { consoleOpen, toggleConsole, noteError } from "./consoleStore";

interface LogRec {
  seq: number;
  ts: number;
  level: string;
  levelno: number;
  group: string;
  source: string;
  msg: string;
}

const LEVELS: [string, number][] = [
  ["DEBUG", 10],
  ["INFO", 20],
  ["WARNING", 30],
  ["ERROR", 40],
];
const MAX_LINES = 1200;

const fmtTime = (ts: number) => {
  const d = new Date(ts * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const lineText = (r: LogRec) => `${fmtTime(r.ts)} ${r.level} ${r.group} ${r.msg}`;

export function LogConsole() {
  const [minLevel, setMinLevel] = createSignal(20);
  const [hidden, setHidden] = createSignal<Set<string>>(new Set());
  const [groups, setGroups] = createSignal<string[]>([]);
  const [search, setSearch] = createSignal("");
  const [logs, setLogs] = createSignal<LogRec[]>([]);
  const [nativeLevel, setNativeLevel] = createSignal("");
  const [nativeLevels, setNativeLevels] = createSignal<string[]>([]);
  let body: HTMLDivElement | undefined;
  let atBottom = true;

  fetch(apiUrl("/api/logs/native-level"))
    .then((r) => r.json())
    .then((d: { level: string | null; levels: string[] }) => {
      setNativeLevels(d.levels);
      if (d.level) setNativeLevel(d.level);
    })
    .catch(() => {});
  const setNative = (lvl: string) => {
    setNativeLevel(lvl);
    fetch(apiUrl(`/api/logs/native-level?level=${lvl}`), { method: "POST" }).catch(() => {});
  };

  const toggleGroup = (g: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  const visible = () => {
    const q = search().toLowerCase();
    return logs().filter(
      (r) =>
        r.levelno >= minLevel() &&
        !hidden().has(r.group) &&
        (!q || r.msg.toLowerCase().includes(q) || r.group.includes(q)),
    );
  };

  // One always-on stream carries every record; filtering is client-side. It runs
  // even while the console is closed so the error badge still counts errors.
  const es = new EventSource(apiUrl("/api/logs/stream"));
  es.onmessage = (ev) => {
    const r = JSON.parse(ev.data) as LogRec;
    if (r.levelno >= 40) noteError();
    batch(() => {
      setLogs((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
        return [...next, r];
      });
      setGroups((g) => (g.includes(r.group) ? g : [...g, r.group].sort()));
    });
  };
  onCleanup(() => es.close());

  createEffect(() => {
    visible();
    if (atBottom && body) queueMicrotask(() => body && (body.scrollTop = body.scrollHeight));
  });
  const onScroll = () => {
    if (body) atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  };

  const copyVisible = () => navigator.clipboard?.writeText(visible().map(lineText).join("\n"));
  const download = () => {
    const blob = new Blob([visible().map(lineText).join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dfdashboard.log";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Show when={consoleOpen()}>
      <section class="log-console">
        <div class="log-head">
          <span class="log-title">CONSOLE</span>
          <div class="log-groups">
            <For each={groups()}>
              {(g) => (
                <button
                  type="button"
                  class="log-chip"
                  classList={{ off: hidden().has(g) }}
                  onClick={() => toggleGroup(g)}
                >
                  {g}
                </button>
              )}
            </For>
          </div>
          <input
            class="log-search"
            type="text"
            placeholder="search"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <select
            class="log-level"
            title="minimum level"
            value={minLevel()}
            onChange={(e) => setMinLevel(Number(e.currentTarget.value))}
          >
            <For each={LEVELS}>{([name, n]) => <option value={n}>{name}+</option>}</For>
          </select>
          <Show when={nativeLevels().length > 0}>
            <select
              class="log-level"
              title="dftracer-utils native log level"
              value={nativeLevel()}
              onChange={(e) => setNative(e.currentTarget.value)}
            >
              <For each={nativeLevels()}>{(lvl) => <option value={lvl}>native: {lvl}</option>}</For>
            </select>
          </Show>
          <button type="button" class="log-btn" title="copy visible" onClick={copyVisible}>
            copy
          </button>
          <button type="button" class="log-btn" title="download visible" onClick={download}>
            save
          </button>
          <button type="button" class="log-btn" title="clear" onClick={() => setLogs([])}>
            clear
          </button>
          <button type="button" class="log-btn" title="close" onClick={toggleConsole}>
            &times;
          </button>
        </div>
        <div class="log-body" ref={body} onScroll={onScroll}>
          <For each={visible()}>
            {(r) => (
              <div class={`log-line log-${r.level.toLowerCase()}`}>
                <span class="log-ts">{fmtTime(r.ts)}</span>
                <span class="log-lvl">{r.level}</span>
                <span class="log-grp">{r.group}</span>
                <span class="log-text">{r.msg}</span>
              </div>
            )}
          </For>
          <Show when={visible().length === 0}>
            <div class="log-empty">no log records for this filter</div>
          </Show>
        </div>
      </section>
    </Show>
  );
}
