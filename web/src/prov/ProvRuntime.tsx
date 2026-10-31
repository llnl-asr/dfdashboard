// Provenance tab: activities on a time axis, one lane per process, with the entities they made and the links between
// them. Click an activity to follow what it used and what used its results.
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
import { linked, runtime, type Runtime, type Span } from "./runtime";
import { entityLabel, PALETTE, typeGraph } from "./typegraph";
import "./prov.css";

const GUTTER = 76;
const AXIS = 24;
const ROW = 18;
const LANE_GAP = 6;
const SPAN_H = 13;
const MIN_SPAN = 2;
const MAX_LINKS_AT_REST = 1500;
const MAX_DOTS = 6;
const ZOOM_STEP = 1.2;
const MAX_ZOOM = 100000;
const TICKS = 8;
const FOLLOW_DEPTH = 1;

const fmtTime = (us: number) => {
  if (us >= 60e6) return `${(us / 60e6).toFixed(1)} min`;
  if (us >= 1e6) return `${(us / 1e6).toFixed(2)} s`;
  if (us >= 1e3) return `${(us / 1e3).toFixed(1)} ms`;
  return `${Math.round(us)} µs`;
};

export function ProvRuntime(props: { mode: "dark" | "light"; live: LiveProv }) {
  let scroller!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const data = () => props.live.data();
  const [pickedAid, setPickedAid] = createSignal<string | null>(null); // by id: new activities move every index
  const [zoom, setZoom] = createSignal(1);
  const [offset, setOffset] = createSignal(0); // fraction of the run left of the view
  const r = createMemo<Runtime | null>(() => {
    const d = data();
    return d ? runtime(d.activities) : null;
  });
  const picked = createMemo(() => {
    const i = r()?.spans.findIndex((s) => s.a.aid === pickedAid()) ?? -1;
    return i < 0 ? null : i;
  });
  const entities = createMemo(
    () => new Map((data()?.entities ?? []).map((e) => [e.hash, e] as const)),
  );
  const typeColor = createMemo(() => {
    const d = data();
    return d ? typeGraph(d).types : new Map();
  });
  const nameColor = createMemo(() => {
    const names = [...new Set(r()?.spans.map((s) => s.a.name) ?? [])].sort();
    return new Map(names.map((n, i) => [n, PALETTE[i % PALETTE.length]] as const));
  });
  const follow = createMemo(() => {
    const p = picked();
    const run = r();
    return p === null || !run ? [] : linked(run, p, FOLLOW_DEPTH);
  });
  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const laneY = (run: Runtime, lane: number) => AXIS + run.lanes[lane].top * ROW + lane * LANE_GAP;
  const spanY = (run: Runtime, s: Span) => laneY(run, s.lane) + s.row * ROW;
  const width = () => Math.max(0, scroller.clientWidth - GUTTER);
  const xOf = (run: Runtime, t: number) => {
    const span = Math.max(run.t1 - run.t0, 1);
    return GUTTER + ((t - run.t0) / span - offset()) * zoom() * width();
  };

  function draw() {
    const run = r();
    if (!run || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = scroller.clientWidth;
    const h = scroller.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const c = canvas.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const top = scroller.scrollTop;
    const [text, muted, border, accent, bg] = [
      css("--text"),
      css("--muted"),
      css("--border"),
      css("--accent"),
      css("--bg"),
    ];
    const seen = (y: number) => y - top > -ROW && y - top < h;
    c.font = "11px ui-monospace, Menlo, monospace";
    const p = picked();

    run.lanes.forEach((l, i) => {
      const y = laneY(run, i);
      if (!seen(y) && !seen(y + l.rows * ROW)) return;
      c.strokeStyle = border;
      c.beginPath();
      c.moveTo(0, y - top - 2);
      c.lineTo(w, y - top - 2);
      c.stroke();
    });
    const near = new Set(follow().flatMap((l) => [l.from, l.to]));
    run.spans.forEach((s, i) => {
      const y = spanY(run, s);
      if (!seen(y)) return;
      const x = xOf(run, s.a.ts);
      const sw = Math.max(xOf(run, s.a.ts + s.a.dur) - x, MIN_SPAN);
      if (x + sw < GUTTER || x > w) return;
      c.globalAlpha = p === null || p === i || near.has(i) ? 1 : 0.25;
      c.fillStyle = nameColor().get(s.a.name) ?? muted;
      c.fillRect(x, y - top, sw, SPAN_H);
      if (p === i) {
        c.strokeStyle = accent;
        c.lineWidth = 2;
        c.strokeRect(x, y - top, sw, SPAN_H);
        c.lineWidth = 1;
      }
      if (sw > 40) {
        c.fillStyle = "#111";
        c.save();
        c.beginPath();
        c.rect(x, y - top, sw, SPAN_H);
        c.clip();
        c.fillText(s.a.name, x + 3, y - top + 10);
        c.restore();
      }
      s.a.generated.slice(0, MAX_DOTS).forEach((e, n) => {
        const t = entities().get(e)?.type ?? "";
        c.fillStyle = typeColor().get(t)?.color ?? text;
        c.strokeStyle = bg;
        c.beginPath();
        c.arc(x + sw - n * 7, y - top + SPAN_H, 3, 0, 2 * Math.PI);
        c.fill();
        c.stroke();
      });
      c.globalAlpha = 1;
    });

    const links = p !== null ? follow() : run.links.length <= MAX_LINKS_AT_REST ? run.links : [];
    c.strokeStyle = p !== null ? accent : muted;
    c.globalAlpha = p !== null ? 0.9 : 0.25;
    c.lineWidth = p !== null ? 1.5 : 1;
    for (const l of links) {
      const a = run.spans[l.from];
      const b = run.spans[l.to];
      const x1 = xOf(run, a.a.ts + a.a.dur);
      const x2 = xOf(run, b.a.ts);
      const y1 = spanY(run, a) + SPAN_H / 2 - top;
      const y2 = spanY(run, b) + SPAN_H / 2 - top;
      const bend = Math.max(Math.abs(x2 - x1) / 2, 12);
      c.beginPath();
      c.moveTo(x1, y1);
      c.bezierCurveTo(x1 + bend, y1, x2 - bend, y2, x2, y2);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.lineWidth = 1;

    c.fillStyle = bg;
    c.fillRect(0, 0, GUTTER, h);
    c.fillStyle = muted;
    run.lanes.forEach((l, i) => {
      const y = laneY(run, i) + 11 - top;
      if (y > AXIS && y < h) c.fillText(String(l.pid), 4, y);
    });
    c.fillStyle = bg;
    c.fillRect(0, 0, w, AXIS);
    c.fillStyle = muted;
    for (let i = 0; i <= TICKS; i++) {
      const x = GUTTER + (i / TICKS) * width();
      const t = (offset() + i / TICKS / zoom()) * (run.t1 - run.t0);
      c.fillText(fmtTime(t), x + 2, 14);
      c.strokeStyle = border;
      c.beginPath();
      c.moveTo(x, 18);
      c.lineTo(x, AXIS);
      c.stroke();
    }
  }

  function spanAt(x: number, y: number): number | null {
    const run = r();
    if (!run) return null;
    const py = y + scroller.scrollTop;
    for (let i = run.spans.length - 1; i >= 0; i--) {
      const s = run.spans[i];
      const sy = spanY(run, s);
      if (py < sy || py > sy + SPAN_H) continue;
      const x1 = xOf(run, s.a.ts);
      if (x >= x1 - 1 && x <= Math.max(xOf(run, s.a.ts + s.a.dur), x1 + MIN_SPAN) + 1) return i;
    }
    return null;
  }

  const clampOffset = (o: number, z: number) => Math.min(Math.max(o, 0), Math.max(1 - 1 / z, 0));
  function wheel(ev: WheelEvent) {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const at = (ev.offsetX - GUTTER) / Math.max(width(), 1);
    const z = Math.min(Math.max(zoom() * (ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), 1), MAX_ZOOM);
    const o = offset() + at / zoom() - at / z;
    setZoom(z);
    setOffset(clampOffset(o, z));
  }
  let dragFrom: { x: number; o: number; moved: boolean } | null = null;
  const down = (ev: MouseEvent) => (dragFrom = { x: ev.clientX, o: offset(), moved: false });
  function move(ev: MouseEvent) {
    if (!dragFrom) return;
    const dx = ev.clientX - dragFrom.x;
    if (Math.abs(dx) > 2) dragFrom.moved = true;
    setOffset(clampOffset(dragFrom.o - dx / Math.max(width(), 1) / zoom(), zoom()));
  }
  function up(ev: MouseEvent) {
    const click = dragFrom && !dragFrom.moved;
    dragFrom = null;
    if (click) {
      const i = spanAt(ev.offsetX, ev.offsetY);
      setPickedAid(i === null ? null : (r()?.spans[i].a.aid ?? null));
    }
  }

  onMount(() => {
    createEffect(
      on(
        () => data() === null,
        (waiting) => {
          if (!waiting) return;
          setPickedAid(null);
          setZoom(1);
          setOffset(0);
        },
      ),
    );
    createEffect(on([r, zoom, offset, picked, () => props.mode], draw));
    const seen = new ResizeObserver(draw);
    seen.observe(scroller);
    onCleanup(() => seen.disconnect());
  });

  const span = () => {
    const p = picked();
    return p === null ? null : (r()?.spans[p] ?? null);
  };
  const entityRow = (hash: string) => {
    const e: ProvEntity | undefined = entities().get(hash);
    return e ? `${e.type}: ${entityLabel(e)}` : hash;
  };
  const height = () => {
    const run = r();
    return run ? AXIS + run.rows * ROW + run.lanes.length * LANE_GAP + ROW : 0;
  };

  return (
    <div class="prov prov-rt">
      <aside class="prov-rail">
        <Show when={!data()}>
          <div class="muted">Scanning trace for provenance records…</div>
        </Show>
        <Show when={r()}>
          {(run) => (
            <section>
              <h3>Run</h3>
              <dl class="prov-stats">
                <dt>activities</dt>
                <dd>{run().spans.length.toLocaleString()}</dd>
                <dt>processes</dt>
                <dd>{run().lanes.length}</dd>
                <dt>links</dt>
                <dd>{run().links.length.toLocaleString()}</dd>
                <dt>duration</dt>
                <dd>{fmtTime(run().t1 - run().t0)}</dd>
              </dl>
              <Show when={run().links.length > MAX_LINKS_AT_REST}>
                <p class="muted">
                  Too many links to draw at once: click an activity to follow its links.
                </p>
              </Show>
            </section>
          )}
        </Show>
        <Show when={span()}>
          {(s) => (
            <section>
              <h3>{s().a.name}</h3>
              <dl class="prov-stats">
                <dt>process</dt>
                <dd>{s().a.pid}</dd>
                <dt>starts</dt>
                <dd>{fmtTime(s().a.ts - (r()?.t0 ?? 0))}</dd>
                <dt>takes</dt>
                <dd>{fmtTime(s().a.dur)}</dd>
              </dl>
              <Show when={s().a.used.length}>
                <h4 class="up">Used</h4>
                <For each={s().a.used}>{(e) => <div>{entityRow(e)}</div>}</For>
              </Show>
              <Show when={s().a.generated.length}>
                <h4 class="down">Made</h4>
                <For each={s().a.generated}>{(e) => <div>{entityRow(e)}</div>}</For>
              </Show>
            </section>
          )}
        </Show>
      </aside>
      <div class="prov-canvas">
        <div ref={scroller} class="prov-rt-scroll" onScroll={draw}>
          <div style={{ height: `${height()}px` }}>
            <canvas
              ref={canvas}
              class="prov-rt-canvas"
              role="img"
              aria-label="Provenance activities over time"
              onWheel={wheel}
              onMouseDown={down}
              onMouseMove={move}
              onMouseUp={up}
              onMouseLeave={() => (dragFrom = null)}
            />
          </div>
        </div>
        <div class="prov-hint">
          {data() && !data()!.activities.length
            ? "This trace has no provenance activities."
            : "Click an activity to follow its links. Ctrl+wheel zooms, drag pans. Dots are the entities it made."}
        </div>
      </div>
    </div>
  );
}
