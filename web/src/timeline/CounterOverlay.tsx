import { createSignal, createEffect, createMemo, For, Show, onCleanup, onMount } from "solid-js";
import { CounterHeatmap } from "./CounterHeatmap";
import { useTraceSource, type Payload, type Series } from "../data/source";

const COLORS = [
  "#4bb0c4",
  "#e6a13c",
  "#b06fc4",
  "#7fb36a",
  "#d1524e",
  "#5b8fd1",
  "#c98a5a",
  "#9aa84e",
];
const H = 150; // overlay/stacked chart height (css px)
const HR = 34; // split-lane chart height (css px)
const MARGIN = 6; // keep one bucket past each edge so the line enters/exits cleanly

const fmtVal = (s: Series, v: number) => {
  if (s.key.endsWith("_pct")) return `${v.toFixed(1)}%`;
  if (s.key === "size")
    return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : `${(v / 1e6).toFixed(1)} MB`;
  if (s.key === "dur") return v >= 1e6 ? `${(v / 1e6).toFixed(1)} s` : `${(v / 1e3).toFixed(1)} ms`;
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toFixed(2);
};
const norm = (s: Series, v: number) => (s.max > s.min ? (v - s.min) / (s.max - s.min) : 0.5);
const yOf = (t: number, h: number) => h - t * (h - 2) - 1;

type Mode = "overlay" | "split" | "stacked";
interface Visible {
  lo: number;
  xs: Float64Array; // css-px x per visible bucket
}

export function CounterOverlay(props: {
  begin: number;
  end: number;
  gutter?: number;
  // Live plot fraction [0,1] of a real timestamp (timelapse-aware, per-frame).
  frac?: (realTs: number) => number;
  // Real timestamp at a plot fraction (for cursor readout under pan/zoom).
  realAtFrac?: (f: number) => number;
  // Ticks each animated timeline frame; drives smooth re-layout.
  tick?: () => number;
  // Dock a counter's per-pid split as lane-background heat on the tracks.
  onDockLane?: (seriesId: string, color: string) => void;
  dockedLane?: () => string | null;
  // Drag-select on the plot zooms the timeline to that real-time range (like the
  // minimap); double-click resets. Wired to timeline.focusRange / resetView.
  onZoomRange?: (t0: number, t1: number) => void;
  onResetView?: () => void;
}) {
  const src = useTraceSource();
  const gutter = () => props.gutter ?? 0;
  const data = src.counterSeries(() =>
    props.end > props.begin ? { begin: props.begin, end: props.end, width: 700 } : null,
  );
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [cursor, setCursor] = createSignal<number | null>(null);
  const [mode, setMode] = createSignal<Mode>("overlay");
  const [collapsed, setCollapsed] = createSignal(false);
  // Drag-select band, as plot fractions [0,1]; null when not dragging.
  const [sel, setSel] = createSignal<{ a: number; b: number } | null>(null);
  // Series expanded into a per-entity heatmap, and the split dimension.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [splitDim, setSplitDim] = createSignal<"pid" | "node">("pid");
  const canSplit = () => src.supportsSplit;
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  let plot: HTMLDivElement | undefined;

  createEffect(() => {
    const d = data();
    if (!d || selected().size > 0 || !d.series.length) return;
    const want = ["cpu/iowait_pct", "read/size", "loss/value"];
    const pick = d.series.filter((s) => want.includes(s.id)).map((s) => s.id);
    setSelected(new Set(pick.length ? pick : d.series.slice(0, 3).map((s) => s.id)));
  });

  // Memoized so panning frames don't re-filter all series every tick.
  const shown = createMemo(() => (data()?.series ?? []).filter((s) => selected().has(s.id)));
  const colorOf = (id: string) => COLORS[shown().findIndex((s) => s.id === id) % COLORS.length];

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Real timestamp at the center of bucket i.
  const tsAt = (d: Payload, i: number) => d.begin + (i + 0.5) * d.bucket_us;
  // Plot fraction [0,1] of bucket i against the live viewport (fallback: fetched window).
  const fracAt = (d: Payload, i: number) => {
    if (props.frac) return props.frac(tsAt(d, i));
    const span = d.buckets * d.bucket_us;
    return span > 0 ? (tsAt(d, i) - d.begin) / span : 0;
  };

  // Counters draw on a 2D canvas (like the tracks and the bandwidth strip) so
  // pan/zoom does not thrash the DOM with 700-point SVG paths every frame; a
  // polyline rasterizes in well under a millisecond.
  let mainCanvas: HTMLCanvasElement | undefined; // overlay + stacked
  const laneCanvases = new Map<string, HTMLCanvasElement>();
  const setLane = (id: string) => (el: HTMLCanvasElement) => laneCanvases.set(id, el);

  const prep = (cv: HTMLCanvasElement, cssH: number) => {
    const cssW = cv.clientWidth || cv.parentElement?.clientWidth || 0;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.round(cssH * dpr);
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    if (cv.style.height !== `${cssH}px`) cv.style.height = `${cssH}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, W: cssW, H: cssH };
  };

  // x(i) is monotonic in i (time increases, toDisplay is monotonic), so binary
  // search the visible window and lay out only on-screen buckets, not all 700.
  const visibleRange = (d: Payload, W: number): Visible | null => {
    const n = d.buckets;
    if (n < 2 || W <= 0) return null;
    let la = 0;
    for (let b = n - 1; la < b;) {
      const m = (la + b) >> 1;
      if (fracAt(d, m) * W < -MARGIN) la = m + 1;
      else b = m;
    }
    let ha = n - 1;
    for (let a = 0; a < ha;) {
      const m = (a + ha + 1) >> 1;
      if (fracAt(d, m) * W > W + MARGIN) ha = m - 1;
      else a = m;
    }
    const lo = Math.max(0, la - 1);
    const hi = Math.min(n - 1, ha + 1);
    if (hi <= lo) return null;
    const xs = new Float64Array(hi - lo + 1);
    for (let k = 0; k < xs.length; k++) xs[k] = fracAt(d, lo + k) * W;
    return { lo, xs };
  };

  const strokeLine = (
    ctx: CanvasRenderingContext2D,
    s: Series,
    vis: Visible,
    h: number,
    color: string,
    fill: boolean,
  ) => {
    const { lo, xs } = vis;
    if (fill) {
      ctx.beginPath();
      ctx.moveTo(xs[0], h);
      for (let k = 0; k < xs.length; k++) ctx.lineTo(xs[k], yOf(norm(s, s.values[lo + k]), h));
      ctx.lineTo(xs[xs.length - 1], h);
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k];
      const y = yOf(norm(s, s.values[lo + k]), h);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = fill ? 1.25 : 1.5;
    ctx.stroke();
  };

  const drawStacked = (
    ctx: CanvasRenderingContext2D,
    d: Payload,
    sh: Series[],
    vis: Visible,
    W: number,
  ) => {
    const n = d.buckets;
    const { lo, xs } = vis;
    // Peak over the full range keeps the y-scale stable while panning.
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (const s of sh) t += Math.max(0, s.values[i] || 0);
      if (t > peak) peak = t;
    }
    const cum = new Float64Array(xs.length);
    for (const s of sh) {
      const color = colorOf(s.id);
      ctx.beginPath();
      for (let k = 0; k < xs.length; k++) ctx.lineTo(xs[k], yOf(cum[k] / peak, H));
      for (let k = xs.length - 1; k >= 0; k--) {
        cum[k] += Math.max(0, s.values[lo + k] || 0);
        ctx.lineTo(xs[k], yOf(cum[k] / peak, H));
      }
      ctx.closePath();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let k = 0; k < xs.length; k++) {
        const y = yOf(cum[k] / peak, H);
        if (k === 0) ctx.moveTo(xs[k], y);
        else ctx.lineTo(xs[k], y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    void W;
  };

  const drawCursor = (ctx: CanvasRenderingContext2D, W: number, h: number) => {
    const c = cursor();
    if (c == null) return;
    const x = Math.round(c * W) + 0.5;
    ctx.save();
    ctx.strokeStyle = "rgba(150,150,150,0.7)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
  };

  const drawSelection = (ctx: CanvasRenderingContext2D, W: number, h: number) => {
    const s = sel();
    if (!s) return;
    const x0 = Math.min(s.a, s.b) * W;
    const x1 = Math.max(s.a, s.b) * W;
    ctx.save();
    ctx.fillStyle = "rgba(230,161,60,0.14)";
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = "rgba(230,161,60,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, h - 1);
    ctx.restore();
  };

  const draw = () => {
    const d = data();
    const sh = shown();
    if (!d || sh.length === 0) return;
    if (mode() === "split") {
      for (const s of sh) {
        const cv = laneCanvases.get(s.id);
        if (!cv) continue;
        const p = prep(cv, HR);
        if (!p) continue;
        const vis = visibleRange(d, p.W);
        if (vis) strokeLine(p.ctx, s, vis, p.H, colorOf(s.id), true);
        drawSelection(p.ctx, p.W, p.H);
        drawCursor(p.ctx, p.W, p.H);
      }
      return;
    }
    const cv = mainCanvas;
    if (!cv) return;
    const p = prep(cv, H);
    if (!p) return;
    const vis = visibleRange(d, p.W);
    if (vis) {
      if (mode() === "stacked") drawStacked(p.ctx, d, sh, vis, p.W);
      else for (const s of sh) strokeLine(p.ctx, s, vis, p.H, colorOf(s.id), false);
    }
    drawSelection(p.ctx, p.W, p.H);
    drawCursor(p.ctx, p.W, p.H);
  };

  createEffect(() => {
    props.tick?.();
    mode();
    shown();
    data();
    cursor();
    sel();
    draw();
  });

  onMount(() => {
    if (!plot) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(plot);
    onCleanup(() => ro.disconnect());
  });

  // Plot fraction [0,1] of a clientX, measured against the chart canvas's own
  // extent (not the plot container: split lane canvases are inset by the gutter).
  const fracAtClientX = (clientX: number): number | null => {
    if (!plot) return null;
    const cv = plot.querySelector("canvas");
    const r = (cv ?? plot).getBoundingClientRect();
    if (r.width <= 0) return null;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const onMove = (e: MouseEvent) => {
    if (sel()) return; // dragging a selection; window listener drives it
    const f = fracAtClientX(e.clientX);
    if (f != null) setCursor(f);
  };

  const MIN_SEL = 0.006; // ignore clicks / tiny drags
  const onDrag = (e: MouseEvent) => {
    const f = fracAtClientX(e.clientX);
    if (f != null) setSel((s) => (s ? { a: s.a, b: f } : null));
  };
  const onUp = (e: MouseEvent) => {
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", onUp);
    const s = sel();
    setSel(null);
    if (!s) return;
    const end = fracAtClientX(e.clientX) ?? s.b;
    const lo = Math.min(s.a, end);
    const hi = Math.max(s.a, end);
    if (hi - lo < MIN_SEL || !props.realAtFrac) return;
    const t0 = props.realAtFrac(lo);
    const t1 = props.realAtFrac(hi);
    if (t1 > t0) props.onZoomRange?.(t0, t1);
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const f = fracAtClientX(e.clientX);
    if (f == null) return;
    e.preventDefault();
    setCursor(null);
    setSel({ a: f, b: f });
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", onUp);
  };
  onCleanup(() => {
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", onUp);
  });
  // Cursor value: map the view-space fraction back to a real ts, then a bucket,
  // so the readout stays correct even mid-zoom (view window != fetched window).
  const valAt = (s: Series, frac: number) => {
    const d = data();
    if (!d) return 0;
    const rt = props.realAtFrac ? props.realAtFrac(frac) : d.begin + frac * d.buckets * d.bucket_us;
    const i = Math.round((rt - d.begin) / d.bucket_us - 0.5);
    return s.values[Math.max(0, Math.min(s.values.length - 1, i))] ?? 0;
  };
  // At the cursor -> the point value; idle -> a min/avg/max/last summary.
  const Readout = (p: { s: Series }) => (
    <Show
      when={cursor() != null}
      fallback={
        <span class="cstat">
          <span>
            min <b>{fmtVal(p.s, p.s.min)}</b>
          </span>
          <span>
            avg <b>{fmtVal(p.s, p.s.mean)}</b>
          </span>
          <span>
            max <b>{fmtVal(p.s, p.s.max)}</b>
          </span>
          <span>
            last <b>{fmtVal(p.s, p.s.last)}</b>
          </span>
        </span>
      }
    >
      <span class="cstat">
        <b>{fmtVal(p.s, valAt(p.s, cursor()!))}</b>
      </span>
    </Show>
  );

  const groups = () => {
    const g: Record<string, Series[]> = {};
    for (const s of data()?.series ?? []) (g[s.family] ??= []).push(s);
    return Object.entries(g);
  };

  const MODES: Mode[] = ["overlay", "split", "stacked"];

  return (
    <Show when={(data()?.series.length ?? 0) > 0}>
      <div class="counters">
        <div class="counters-bar">
          <button
            type="button"
            class="counters-collapse"
            classList={{ open: !collapsed() }}
            title={collapsed() ? "show counter list" : "hide counter list"}
            onClick={() => setCollapsed((c) => !c)}
          />
          <div class="counters-modes">
            <For each={MODES}>
              {(m) => (
                <button type="button" classList={{ on: mode() === m }} onClick={() => setMode(m)}>
                  {m}
                </button>
              )}
            </For>
          </div>
          <span class="counters-count">{shown().length} shown</span>
        </div>
        {/* Only the picker (pills) collapses; the bar and chart stay. The
            top-right toolbar button hides the whole panel instead. */}
        <Show when={!collapsed()}>
          <div class="counters-pick">
            <For each={groups()}>
              {([family, list]) => (
                <div class="counters-group">
                  <span class="counters-fam">{family}</span>
                  <div class="counters-chips">
                    <For each={list}>
                      {(s) => (
                        <button
                          type="button"
                          class="counters-chip"
                          classList={{ on: selected().has(s.id) }}
                          onClick={() => toggle(s.id)}
                        >
                          {s.name}·{s.key}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div
          class="counters-plot"
          classList={{ selectable: !!props.onZoomRange }}
          ref={plot}
          onMouseMove={onMove}
          onMouseLeave={() => setCursor(null)}
          onMouseDown={onDown}
          onDblClick={() => props.onResetView?.()}
        >
          <Show
            when={shown().length}
            fallback={
              <div class="counters-empty">
                {selected().size > 0
                  ? "no data for the selected counters in this window"
                  : "pick counters to overlay"}
              </div>
            }
          >
            <Show when={mode() === "split"}>
              <For each={shown()}>
                {(s) => (
                  <div class="counters-lane">
                    <div class="counters-lane-head" style={{ flex: `0 0 ${gutter()}px` }}>
                      <span class="counters-lane-label" style={{ color: colorOf(s.id) }}>
                        {s.name}·{s.key}
                      </span>
                      <Readout s={s} />
                    </div>
                    <canvas class="counters-lane-canvas" ref={setLane(s.id)} />
                  </div>
                )}
              </For>
            </Show>

            <Show when={mode() !== "split"}>
              <div class="counters-chart">
                {/* Legend lives in the otherwise-empty left gutter, aligned with
                      the track labels, so it does not pack under the plot. */}
                <div class="counters-legend" style={{ flex: `0 0 ${gutter()}px` }}>
                  <For each={shown()}>
                    {(s) => (
                      <div class="counters-leg">
                        <div class="counters-leg-top">
                          <Show when={canSplit()}>
                            <button
                              type="button"
                              class="counters-expand"
                              classList={{ on: expanded().has(s.id) }}
                              title={expanded().has(s.id) ? "hide split" : "split by pid/node"}
                              onClick={() => toggleExpand(s.id)}
                            >
                              {expanded().has(s.id) ? "-" : "+"}
                            </button>
                          </Show>
                          <span class="counters-leg-name" style={{ color: colorOf(s.id) }}>
                            {s.name}·{s.key}
                          </span>
                        </div>
                        <Readout s={s} />
                      </div>
                    )}
                  </For>
                </div>
                <canvas class="counters-main-canvas" ref={mainCanvas} />
              </div>
            </Show>
          </Show>
        </div>

        <Show when={canSplit()}>
          <For each={shown().filter((s) => expanded().has(s.id))}>
            {(s) => (
              <CounterHeatmap
                seriesId={s.id}
                name={s.name}
                key_={s.key}
                color={colorOf(s.id)}
                dim={splitDim()}
                begin={props.begin}
                end={props.end}
                gutter={gutter()}
                frac={(t) => props.frac?.(t) ?? 0}
                realAtFrac={(f) => props.realAtFrac?.(f) ?? 0}
                tick={() => props.tick?.() ?? 0}
                onClose={() => toggleExpand(s.id)}
                onDim={setSplitDim}
                docked={props.dockedLane?.() === s.id}
                onDock={props.onDockLane ? () => props.onDockLane!(s.id, colorOf(s.id)) : undefined}
              />
            )}
          </For>
        </Show>
      </div>
    </Show>
  );
}
