import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js";
import { useTraceSource, type SplitPayload } from "../data/source";

type View = "heatmap" | "band";

const ROW_MAX = 16; // px per entity row when there is room
const ROW_MIN = 7;
const PANEL_H = 224; // max heatmap plot height (css px)
const BAND_H = 130; // band view height (css px)
const PANEL_BG: [number, number, number] = [10, 11, 10];
const MARGIN = 6;

const hexRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Sequential single-hue ramp: panel background (empty) -> the counter's own
// color (hot). Precomputed into fixed steps so the draw loop only swaps
// fillStyle a handful of times, not per cell.
const RAMP_STEPS = 24;
function buildRamp(color: string): string[] {
  const c = hexRgb(color);
  const out: string[] = [];
  for (let i = 0; i < RAMP_STEPS; i++) {
    const t = i / (RAMP_STEPS - 1);
    const r = Math.round(PANEL_BG[0] + (c[0] - PANEL_BG[0]) * t);
    const g = Math.round(PANEL_BG[1] + (c[1] - PANEL_BG[1]) * t);
    const b = Math.round(PANEL_BG[2] + (c[2] - PANEL_BG[2]) * t);
    out.push(`rgb(${r},${g},${b})`);
  }
  return out;
}

const fmtVal = (key: string, v: number) => {
  if (key.endsWith("_pct")) return `${v.toFixed(1)}%`;
  if (key === "size") return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : `${(v / 1e6).toFixed(1)} MB`;
  if (key === "dur") return v >= 1e6 ? `${(v / 1e6).toFixed(1)} s` : `${(v / 1e3).toFixed(1)} ms`;
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toFixed(2);
};

export function CounterHeatmap(props: {
  seriesId: string;
  name: string;
  key_: string;
  color: string;
  dim: string;
  begin: number;
  end: number;
  gutter: number;
  frac: (realTs: number) => number;
  realAtFrac: (f: number) => number;
  tick: () => number;
  onClose: () => void;
  onDim: (dim: string) => void;
  docked?: boolean;
  onDock?: () => void;
}) {
  const src = useTraceSource();
  const data = src.counterSplit(() =>
    props.end > props.begin
      ? {
          begin: props.begin,
          end: props.end,
          series: props.seriesId,
          dim: props.dim,
          width: 700,
          top: 24,
        }
      : null,
  );
  const [hover, setHover] = createSignal<{ row: number; frac: number } | null>(null);
  const [view, setView] = createSignal<View>("heatmap");
  const [pinned, setPinned] = createSignal<Set<string>>(new Set());
  let canvas: HTMLCanvasElement | undefined;
  let wrap: HTMLDivElement | undefined;
  let ramp = buildRamp(props.color);
  createEffect(() => {
    ramp = buildRamp(props.color);
  });

  const rowH = () => {
    const n = data()?.entities.length ?? 1;
    return Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(PANEL_H / Math.max(n, 1))));
  };
  const plotH = () =>
    view() === "band" ? BAND_H : Math.max((data()?.entities.length ?? 0) * rowH(), rowH());

  // Shared visible-bucket window (x monotonic in i).
  const visible = (d: SplitPayload, xAt: (i: number) => number, W: number) => {
    const n = d.buckets;
    let lo = 0;
    for (let b = n - 1; lo < b;) {
      const m = (lo + b) >> 1;
      if (xAt(m) < -MARGIN) lo = m + 1;
      else b = m;
    }
    let hi = n - 1;
    for (let a = 0; a < hi;) {
      const m = (a + hi + 1) >> 1;
      if (xAt(m) > W + MARGIN) hi = m - 1;
      else a = m;
    }
    return { lo: Math.max(0, lo - 1), hi: Math.min(n - 1, hi + 1) };
  };

  const drawHeatmap = (
    ctx: CanvasRenderingContext2D,
    d: SplitPayload,
    W: number,
    xAt: (i: number) => number,
    lo: number,
    hi: number,
  ) => {
    const rh = rowH();
    const n = d.buckets;
    let gmax = 1e-9;
    for (const e of d.entities) if (e.max > gmax) gmax = e.max;
    for (let r = 0; r < d.entities.length; r++) {
      const e = d.entities[r];
      const y = r * rh;
      for (let i = lo; i <= hi; i++) {
        const v = e.values[i];
        if (v <= 0) continue;
        const t = Math.sqrt(v / gmax);
        const step = Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(t * (RAMP_STEPS - 1))));
        const x0 = xAt(i);
        const x1 = i + 1 < n ? xAt(i + 1) : x0 + W / n;
        ctx.fillStyle = ramp[step];
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), rh - (rh > 9 ? 1 : 0));
      }
      if (pinned().has(e.entity)) {
        ctx.fillStyle = "#e6e2ce";
        ctx.fillRect(0, y, 2, rh);
      }
    }
    const h = hover();
    if (h && h.row >= 0 && h.row < d.entities.length) {
      ctx.strokeStyle = "rgba(230,161,60,0.7)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, h.row * rh + 0.5, W - 1, rh - 1);
    }
  };

  const drawBand = (
    ctx: CanvasRenderingContext2D,
    d: SplitPayload,
    H: number,
    xAt: (i: number) => number,
    lo: number,
    hi: number,
  ) => {
    const band = d.band;
    if (!band) return;
    let gmax = 1e-9;
    for (let i = 0; i < d.buckets; i++) if (band.p90[i] > gmax) gmax = band.p90[i];
    for (const e of d.entities) if (pinned().has(e.entity) && e.max > gmax) gmax = e.max;
    const yOf = (v: number) => H - (v / gmax) * (H - 2) - 1;
    ctx.beginPath();
    for (let i = lo; i <= hi; i++) ctx.lineTo(xAt(i), yOf(band.p90[i]));
    for (let i = hi; i >= lo; i--) ctx.lineTo(xAt(i), yOf(band.p10[i]));
    ctx.closePath();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = props.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = lo; i <= hi; i++) {
      const x = xAt(i);
      const y = yOf(band.p50[i]);
      if (i === lo) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = props.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    for (const e of d.entities) {
      if (!pinned().has(e.entity)) continue;
      ctx.beginPath();
      for (let i = lo; i <= hi; i++) {
        const x = xAt(i);
        const y = yOf(e.values[i]);
        if (i === lo) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#e6e2ce";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  const draw = () => {
    const d = data();
    const cv = canvas;
    if (!d || !cv || d.entities.length === 0) return;
    const cssW = cv.clientWidth || 0;
    const cssH = plotH();
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = `rgb(${PANEL_BG[0]},${PANEL_BG[1]},${PANEL_BG[2]})`;
    ctx.fillRect(0, 0, cssW, cssH);

    const xAt = (i: number) => props.frac(d.begin + (i + 0.5) * d.bucket_us) * cssW;
    const { lo, hi } = visible(d, xAt, cssW);
    if (view() === "band") drawBand(ctx, d, cssH, xAt, lo, hi);
    else drawHeatmap(ctx, d, cssW, xAt, lo, hi);

    const h = hover();
    if (h) {
      const cx = Math.round(h.frac * cssW) + 0.5;
      ctx.strokeStyle = "rgba(200,200,200,0.5)";
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, cssH);
      ctx.stroke();
    }
  };

  createEffect(() => {
    props.tick();
    data();
    hover();
    view();
    pinned();
    draw();
  });
  onMount(() => {
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    onCleanup(() => ro.disconnect());
  });

  const onMove = (e: MouseEvent) => {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const row = Math.floor(((e.clientY - r.top) / r.height) * (data()?.entities.length ?? 1));
    setHover({ row, frac: f });
  };

  const rowAt = (clientY: number) => {
    const d = data();
    if (!canvas || !d) return -1;
    const r = canvas.getBoundingClientRect();
    if (r.height <= 0) return -1;
    return Math.floor(((clientY - r.top) / r.height) * d.entities.length);
  };
  const onClick = (e: MouseEvent) => {
    if (view() !== "heatmap") return;
    const d = data();
    if (!d) return;
    const ent = d.entities[rowAt(e.clientY)];
    if (!ent || ent.entity === "__other__") return;
    setPinned((s) => {
      const n = new Set(s);
      if (n.has(ent.entity)) n.delete(ent.entity);
      else n.add(ent.entity);
      return n;
    });
  };

  const readout = (): { label: string; v: number; hi?: number } | null => {
    const d = data();
    const h = hover();
    if (!d || !h) return null;
    const rt = props.realAtFrac(h.frac);
    const i = Math.max(0, Math.min(d.buckets - 1, Math.round((rt - d.begin) / d.bucket_us - 0.5)));
    if (view() === "band") {
      const b = d.band;
      return b ? { label: "median", v: b.p50[i], hi: b.p90[i] } : null;
    }
    if (h.row < 0 || h.row >= d.entities.length) return null;
    return { label: d.entities[h.row].label, v: d.entities[h.row].values[i] ?? 0 };
  };

  return (
    <div class="cheat" ref={wrap}>
      <div class="cheat-bar">
        <span class="cheat-title" style={{ color: props.color }}>
          {props.name}·{props.key_}
        </span>
        <div class="cheat-dims">
          <button
            type="button"
            classList={{ on: props.dim === "pid" }}
            onClick={() => props.onDim("pid")}
          >
            per pid
          </button>
          <button
            type="button"
            classList={{ on: props.dim === "node" }}
            onClick={() => props.onDim("node")}
          >
            per node
          </button>
        </div>
        <div class="cheat-dims">
          <button
            type="button"
            classList={{ on: view() === "heatmap" }}
            onClick={() => setView("heatmap")}
          >
            heatmap
          </button>
          <button
            type="button"
            classList={{ on: view() === "band" }}
            onClick={() => setView("band")}
          >
            band
          </button>
        </div>
        <span class="cheat-count">
          {data()?.total_entities ?? 0} {props.dim === "pid" ? "procs" : "nodes"}
        </span>
        <span class="cheat-read">
          {(() => {
            const r = readout();
            return r ? (
              <>
                <b>{r.label}</b> {fmtVal(props.key_, r.v)}
                {r.hi != null ? <> · p90 {fmtVal(props.key_, r.hi)}</> : null}
              </>
            ) : null;
          })()}
        </span>
        <Show when={props.onDock && props.dim === "pid"}>
          <button
            type="button"
            class="cheat-dock"
            classList={{ on: props.docked }}
            title={props.docked ? "remove from tracks" : "show behind track lanes"}
            onClick={() => props.onDock?.()}
          >
            tracks
          </button>
        </Show>
        <button type="button" class="cheat-close" title="collapse" onClick={() => props.onClose()}>
          x
        </button>
      </div>
      <div class="cheat-plot" style={{ height: `${plotH()}px` }}>
        <div class="cheat-labels" style={{ flex: `0 0 ${props.gutter}px` }}>
          <Show
            when={view() === "heatmap"}
            fallback={<span class="cheat-band-label">p10-p90 · median</span>}
          >
            {(data()?.entities ?? []).map((e) => (
              <span
                class="cheat-label"
                classList={{ pinned: pinned().has(e.entity) }}
                style={{ height: `${rowH()}px` }}
                title={e.label}
              >
                {rowH() >= 11 ? e.label : ""}
              </span>
            ))}
          </Show>
        </div>
        <canvas
          class="cheat-canvas"
          classList={{ clickable: view() === "heatmap" }}
          ref={canvas}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
        />
      </div>
    </div>
  );
}
