import { createSignal, createEffect, onMount, onCleanup, Show, For } from "solid-js";
import { apiUrl } from "../data/api";
import BokehEmbed from "./BokehEmbed";

interface ParamSpec {
  type?: string;
  default?: unknown;
}
interface PipelineInfo {
  id: string;
  label: string;
  params_schema?: { properties?: Record<string, ParamSpec> };
}

interface TaskRec {
  task_id: string;
  state: string;
  progress: number;
  message: string;
  error: string | null;
  spec: { pipeline_id: string; params?: Record<string, unknown> };
  t_submitted: number;
  t_started: number | null;
  t_done: number | null;
}

interface TaskResult {
  data: unknown;
  meta: Record<string, unknown>;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "interrupted"]);
const isActive = (s: string) => s === "queued" || s === "running";

export default function Analysis(props: { active: boolean }) {
  const [pipelines, setPipelines] = createSignal<PipelineInfo[]>([]);
  const [selected, setSelected] = createSignal("");
  const [task, setTask] = createSignal("");
  const [rec, setRec] = createSignal<TaskRec | null>(null);
  const [history, setHistory] = createSignal<TaskRec[]>([]);
  const [result, setResult] = createSignal<TaskResult | null>(null);
  const [paramValues, setParamValues] = createSignal<Record<string, unknown>>({});
  const [now, setNow] = createSignal(Date.now() / 1000);
  let es: EventSource | undefined;

  onMount(async () => {
    const pls = (await (await fetch(apiUrl("/api/pipelines"))).json()) as PipelineInfo[];
    setPipelines(pls);
    if (pls.length) setSelected(pls[0].id);
  });

  const paramProps = () =>
    pipelines().find((p) => p.id === selected())?.params_schema?.properties ?? {};
  createEffect(() => {
    const init: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(paramProps())) init[k] = v.default ?? "";
    setParamValues(init);
  });
  const isNum = (t?: string) => t === "integer" || t === "number";
  const setParam = (k: string, raw: string, type?: string) =>
    setParamValues((v) => ({ ...v, [k]: isNum(type) ? (raw === "" ? "" : Number(raw)) : raw }));
  const cleanParams = () =>
    Object.fromEntries(Object.entries(paramValues()).filter(([, v]) => v !== "" && v != null));

  const refreshHistory = async () => {
    try {
      const rows = (await (await fetch(apiUrl("/api/tasks"))).json()) as TaskRec[];
      setHistory(rows.sort((a, b) => b.t_submitted - a.t_submitted));
    } catch {
      /* transient */
    }
  };
  createEffect(() => {
    if (!props.active) return;
    refreshHistory();
    const t = setInterval(refreshHistory, 3000);
    onCleanup(() => clearInterval(t));
  });

  const running = () => isActive(rec()?.state ?? "");
  const label = (id: string) => pipelines().find((p) => p.id === id)?.label ?? id;
  const dur = (r: TaskRec) => (r.t_started == null ? 0 : (r.t_done ?? now()) - r.t_started);

  const fetchResult = async (id: string) => {
    try {
      const d = (await (await fetch(apiUrl(`/api/tasks/${id}`))).json()) as { result?: TaskResult };
      setResult(d.result ?? null);
    } catch {
      setResult(null);
    }
  };

  function watch(taskId: string) {
    es?.close();
    setResult(null);
    es = new EventSource(apiUrl(`/api/tasks/${taskId}/events`));
    es.onmessage = (ev) => {
      const r = JSON.parse(ev.data) as TaskRec;
      setRec(r);
      if (TERMINAL.has(r.state)) {
        es?.close();
        refreshHistory();
        if (r.state === "done") fetchResult(taskId);
      }
    };
    es.onerror = () => es?.close();
  }

  async function submit(pipeline_id: string, params?: Record<string, unknown>) {
    setRec(null);
    const res = await fetch(apiUrl("/api/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline_id, params: params ?? {}, lane: 0 }),
    });
    const { task_id } = (await res.json()) as { task_id: string };
    setTask(task_id);
    watch(task_id);
    refreshHistory();
  }

  const run = () => selected() && submit(selected(), cleanParams());
  const rerun = (r: TaskRec) => submit(r.spec.pipeline_id, r.spec.params);
  const cancelId = async (id: string) => {
    await fetch(apiUrl(`/api/tasks/${id}`), { method: "DELETE" });
    refreshHistory();
  };
  const cancel = () => task() && cancelId(task());
  const open = (r: TaskRec) => {
    setTask(r.task_id);
    setRec(r);
    setResult(null);
    if (isActive(r.state)) watch(r.task_id);
    else if (r.state === "done") fetchResult(r.task_id);
  };

  const ticker = window.setInterval(() => {
    if (running()) setNow(Date.now() / 1000);
  }, 1000);
  onCleanup(() => {
    es?.close();
    clearInterval(ticker);
  });

  return (
    <div class="body analysis-body" style={{ display: props.active ? "flex" : "none" }}>
      <div class="card">
        <div class="card-head">
          <h2>Analysis</h2>
          <div class="run-controls">
            <select value={selected()} onChange={(e) => setSelected(e.currentTarget.value)}>
              <For each={pipelines()}>{(p) => <option value={p.id}>{p.label}</option>}</For>
            </select>
            <Show
              when={running()}
              fallback={
                <button type="button" onClick={run} disabled={!selected()}>
                  Run
                </button>
              }
            >
              <button type="button" class="btn-cancel" onClick={cancel}>
                Cancel
              </button>
            </Show>
          </div>
        </div>

        <Show when={Object.keys(paramProps()).length > 0}>
          <div class="param-form">
            <For each={Object.entries(paramProps())}>
              {([name, spec]) => (
                <label class="param-field">
                  <span>{name}</span>
                  <input
                    type={isNum(spec.type) ? "number" : "text"}
                    value={String(paramValues()[name] ?? "")}
                    onInput={(e) => setParam(name, e.currentTarget.value, spec.type)}
                  />
                </label>
              )}
            </For>
          </div>
        </Show>

        <Show when={rec()}>
          {(r) => (
            <div class="task-status">
              <div class="task-status-head">
                <span class="task-pipeline">{label(r().spec.pipeline_id)}</span>
                <span class={`task-badge task-${r().state}`}>{r().state}</span>
                <span class="task-elapsed">{dur(r()).toFixed(1)}s</span>
              </div>
              <div class="task-bar">
                <div
                  class="task-bar-fill"
                  classList={{ indeterminate: r().state === "queued" }}
                  style={{ width: `${Math.round(r().progress * 100)}%` }}
                />
              </div>
              <div class="task-msg">
                <Show when={r().error} fallback={r().message || " "}>
                  <span class="task-err">{r().error}</span>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <BokehEmbed task={task()} class="panel-plot" />

        <Show when={result()}>
          {(res) => (
            <div class="result-block">
              <div class="result-head">RESULT</div>
              <Show when={Object.keys(res().meta).length > 0}>
                <div class="result-meta">
                  <For each={Object.entries(res().meta)}>
                    {([k, v]) => (
                      <span class="result-chip">
                        {k}: {String(v)}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <pre class="result-json">{JSON.stringify(res().data, null, 2)}</pre>
            </div>
          )}
        </Show>
      </div>

      <Show when={history().length > 0}>
        <div class="card task-history">
          <div class="card-head">
            <h2>History</h2>
          </div>
          <For each={history()}>
            {(r) => (
              <div
                class="thist-row"
                classList={{ current: r.task_id === task() }}
                onClick={() => open(r)}
              >
                <span class={`task-badge task-${r.state}`}>{r.state}</span>
                <span class="thist-label">{label(r.spec.pipeline_id)}</span>
                <span class="thist-dur">{dur(r).toFixed(1)}s</span>
                <div class="thist-actions">
                  <Show when={isActive(r.state)}>
                    <button
                      type="button"
                      title="cancel"
                      onClick={(e) => (e.stopPropagation(), cancelId(r.task_id))}
                    >
                      cancel
                    </button>
                  </Show>
                  <button
                    type="button"
                    title="re-run"
                    onClick={(e) => (e.stopPropagation(), rerun(r))}
                  >
                    re-run
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
