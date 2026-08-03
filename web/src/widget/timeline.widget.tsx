import type { AnyModel, RenderProps } from "@anywidget/types";
import { render } from "solid-js/web";
import { createSignal, onCleanup, onMount } from "solid-js";
import { inflate, parseCountersIpc, parseProctreeIpc, parseTimelineIpc } from "../timeline/ipc";
import { Timeline, GUTTER } from "../timeline/timeline";
import { CounterOverlay } from "../timeline/CounterOverlay";
import { TraceSourceContext, type Payload, type TraceSource } from "../data/source";
import widgetTokens from "./widget.css?inline";
import counterCss from "../timeline/counters.css?inline";

type Bytes = DataView | ArrayBuffer | Uint8Array;

interface TimelineState {
  begin: number;
  end: number;
  width: number;
  span: number;
  req: number;
  timeline_ipc: Bytes;
  counters_ipc: Bytes;
  series_ipc: Bytes;
  proctree_ipc: Bytes;
  overview_ipc: Bytes;
  breaks_gaps: number[][];
  multi_run: boolean;
}

const STYLE_ID = "dfd-counter-widget-css";
// anywidget renders in a shadow root isolated from document styles, so the
// counter CSS must be injected into that root, not the document head.
function ensureCss(node: Element): void {
  const root = node.getRootNode() as Document | ShadowRoot;
  if (root.querySelector(`#${STYLE_ID}`)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  // Tokens first: they define the vars the shared counter rules reference.
  el.textContent = `${widgetTokens}\n${counterCss}`;
  root.appendChild(el);
}

function toU8(v: Bytes | undefined): Uint8Array {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof DataView) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(0);
}

function Widget(props: { model: AnyModel<TimelineState> }) {
  const m = props.model;
  let canvas!: HTMLCanvasElement;
  let tlRef: Timeline | undefined;
  const [payload, setPayload] = createSignal<Payload | null>(null);
  // Only counterSeries is wired over comm; split/node counters report null.
  const commSource: TraceSource = {
    supportsSplit: false,
    counterSeries: () => payload,
    counterSplit: () => () => null,
    nodeCounters: () => () => null,
  };
  const [tick, setTick] = createSignal(0);
  const [begin, setBegin] = createSignal(m.get("begin"));
  const [end, setEnd] = createSignal(m.get("end") || m.get("span"));

  onMount(() => {
    ensureCss(canvas);
    let req = 0;
    const tl = new Timeline(canvas, {
      onRangeChange: (b, e) => {
        setBegin(b);
        setEnd(e);
        m.set("begin", b);
        m.set("end", e);
        m.set("width", tl.viewportWidth());
        m.set("req", ++req);
        m.save_changes();
      },
      // Re-lay the counter overlay in lockstep with each track frame.
      onFrame: () => setTick((t) => (t + 1) & 0xffff),
    });
    tlRef = tl;
    tl.setTheme("dark");

    const applySpan = () => {
      const s = m.get("span");
      if (s > 0) tl.setTotalSpan(s);
    };
    const feed = () => {
      const { events, density } = parseTimelineIpc(inflate(toU8(m.get("timeline_ipc"))));
      tl.setData(events, density);
    };
    const feedCounters = () => {
      const { read, write } = parseCountersIpc(inflate(toU8(m.get("counters_ipc"))));
      if (!read.length) return;
      const begin = m.get("begin");
      const bucketUs = (m.get("end") - begin) / read.length;
      tl.setCounters(begin, bucketUs, read, write);
    };
    const feedOverview = () => {
      const { density } = parseTimelineIpc(inflate(toU8(m.get("overview_ipc"))));
      if (density.length) tl.setOverview(density);
    };
    const feedBreaks = () => {
      const gaps = (m.get("breaks_gaps") || []).map((p) => ({ begin: p[0], end: p[1] }));
      tl.setBreaks(gaps, Boolean(m.get("multi_run")));
    };
    const feedProctree = () => {
      const nodes = parseProctreeIpc(inflate(toU8(m.get("proctree_ipc"))));
      if (!nodes.length) return;
      tl.setProcTree(nodes);
      const hosts = new Map<number, string>();
      const bytes = new Map<number, number>();
      const ioBusy = new Map<number, number>();
      const labels = new Map<string, string>();
      for (const n of nodes) {
        if (n.host) hosts.set(n.pid, n.host);
        if (n.bytes) bytes.set(n.pid, n.bytes);
        if (n.io_busy) ioBusy.set(n.pid, n.io_busy);
        const hasRank = n.rank != null && n.rank !== "";
        labels.set(String(n.pid), hasRank ? `rank ${n.rank}` : `proc ${n.pid}`);
      }
      tl.setHosts(hosts);
      tl.setBytes(bytes);
      tl.setIoBusy(ioBusy);
      tl.setProcessLabels(labels);
    };
    // Mirror the SPA Payload shape so CounterOverlay stays transport-agnostic.
    const feedSeries = () => {
      const raw = inflate(toU8(m.get("series_ipc")));
      if (!raw.length) {
        setPayload(null);
        return;
      }
      try {
        setPayload(JSON.parse(new TextDecoder().decode(raw)) as Payload);
      } catch {
        setPayload(null);
      }
    };
    applySpan();
    feedOverview();
    feedProctree();
    feedBreaks();
    feed();
    feedCounters();
    feedSeries();
    m.on("change:span", applySpan);
    m.on("change:overview_ipc", feedOverview);
    m.on("change:breaks_gaps", feedBreaks);
    m.on("change:timeline_ipc", feed);
    m.on("change:counters_ipc", feedCounters);
    m.on("change:series_ipc", feedSeries);
    m.on("change:proctree_ipc", feedProctree);

    onCleanup(() => {
      m.off("change:span", applySpan);
      m.off("change:overview_ipc", feedOverview);
      m.off("change:breaks_gaps", feedBreaks);
      m.off("change:timeline_ipc", feed);
      m.off("change:counters_ipc", feedCounters);
      m.off("change:series_ipc", feedSeries);
      m.off("change:proctree_ipc", feedProctree);
      tl.destroy();
    });
  });

  return (
    <div
      style={{
        width: "100%",
        height: "460px",
        background: "#0a0b0a",
        display: "flex",
        "flex-direction": "column",
      }}
    >
      <TraceSourceContext.Provider value={commSource}>
        <CounterOverlay
          begin={begin()}
          end={end()}
          gutter={GUTTER}
          tick={tick}
          frac={(t) => tlRef?.frac(t) ?? 0}
          realAtFrac={(f) => tlRef?.realAtFrac(f) ?? 0}
          onZoomRange={(t0, t1) => tlRef?.focusRealRange(t0, t1)}
          onResetView={() => tlRef?.resetView()}
        />
      </TraceSourceContext.Provider>
      <canvas ref={canvas} style={{ width: "100%", flex: "1 1 auto", display: "block" }} />
    </div>
  );
}

export default {
  render({ model, el }: RenderProps<TimelineState>) {
    const dispose = render(() => <Widget model={model} />, el);
    return () => dispose();
  },
};
