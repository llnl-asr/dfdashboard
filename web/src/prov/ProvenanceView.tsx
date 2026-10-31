// Provenance tab: the lineage graph of a dftracer provenance-mode trace.
//
// Data comes from GET /api/prov/graph (trace::provenance::extract_provenance_graph
// on the server). Entities are ellipses colored by entity type, activities are
// boxes, edges run cause -> activity -> effect. The entity picker selects ids of
// one type and highlights their full lineage (upstream) and impact (downstream).
// Files touched by activities are nodes too (label: path relative to its mount);
// mount points are storage nodes. Edges: read file->activity, write
// activity->file, entity -stored in-> file, file -on-> storage.
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
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
import { fetchProvGraph, type ProvGraphResponse } from "../data/api";
import type { LiveProv } from "./live";
import { PALETTE } from "./typegraph";
import "./prov.css";

cytoscape.use(dagre);

const DATA_OPS = new Set(["read", "write"]);
const FILE_COLOR = "#7f9cc2";
const MOUNT_COLOR = "#a07bd1";

const fileId = (path: string) => "F:" + path;
const IO_COLOR = "#9aa7b4";

// One link from an activity to each file it touched.
function ioEdges(d: ProvGraphResponse): cytoscape.ElementDefinition[] {
  const pairs = new Set((d.accesses ?? []).map((x) => "A:" + x.aid + "\u001f" + fileId(x.path)));
  return [...pairs].map((p) => {
    const [source, target] = p.split("\u001f");
    return { data: { source, target, kind: "ioagg", dir: "any", color: IO_COLOR } };
  });
}

// Display name for an entity. With the dftracer entity API the id is a 64-bit
// hash (the app key is not stored), so prefer the uri's file name.
function entityLabel(e: { id: string; uri: string }): string {
  if (e.uri) {
    const parts = e.uri.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || e.uri;
  }
  return /^[0-9a-f]{16}$/.test(e.id) ? e.id.slice(0, 10) + "…" : e.id;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

type Selection = {
  up: number;
  down: number;
  roots: { type: string; id: string }[];
  upTypes: [string, number][];
  downTypes: [string, number][];
  picked: number;
  files: number;
  storage: string[];
};

function count(nodes: cytoscape.NodeCollection): [string, number][] {
  const m = new Map<string, number>();
  nodes.forEach((n) => {
    m.set(n.data("etype"), (m.get(n.data("etype")) ?? 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function ProvenanceView(props: { mode: "dark" | "light"; scope: string; live: LiveProv }) {
  let host!: HTMLDivElement;
  let cy: cytoscape.Core | undefined;
  const [data, setData] = createSignal<ProvGraphResponse | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [ptype, setPtype] = createSignal("");
  const [picked, setPicked] = createSignal<string[]>([]);
  const [detail, setDetail] = createSignal<Record<string, string> | null>(null);
  const [sel, setSel] = createSignal<Selection | null>(null);
  // View scope: when non-empty, only these entities and their neighborhood are drawn.
  const ctrl = new AbortController();
  onCleanup(() => {
    ctrl.abort();
    cy?.destroy();
  });

  // Entity types with the producer's role/description (prov_type records),
  // ordered inputs -> intermediates -> outputs.
  const ROLE_ORDER: Record<string, number> = { input: 0, intermediate: 1, output: 2 };
  const typeInfo = createMemo(
    () => new Map((data()?.types ?? []).map((t) => [t.name, t] as const)),
  );
  const types = createMemo(() => {
    const d = data();
    if (!d) return [] as { t: string; n: number; c: string; role: string; desc: string }[];
    const m = new Map<string, number>();
    d.entities.forEach((e) => m.set(e.type, (m.get(e.type) ?? 0) + 1));
    const info = typeInfo();
    return [...m.keys()]
      .sort()
      .map((t, i) => ({
        t,
        n: m.get(t)!,
        c: PALETTE[i % PALETTE.length],
        role: info.get(t)?.role ?? "",
        desc: info.get(t)?.description ?? "",
      }))
      .sort(
        (a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || a.t.localeCompare(b.t),
      );
  });
  const colorOf = createMemo(() => new Map(types().map((x) => [x.t, x.c])));
  const idsOfType = createMemo((): { hash: string; id: string }[] => {
    const d = data();
    if (!d || !ptype()) return [];
    if (ptype() === "(file)")
      return (d.files ?? [])
        .map((f) => ({ hash: "F:" + f.path, id: `${f.rel}  [${f.mount}]` }))
        .sort((a, b) => a.id.localeCompare(b.id));
    if (ptype() === "(storage)")
      return (d.mounts ?? []).map((m) => ({ hash: "M:" + m.path, id: `${m.path} (${m.fstype})` }));
    return d.entities
      .filter((e) => e.type === ptype())
      .map((e) => ({ hash: e.hash, id: entityLabel(e) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  });

  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function style(): cytoscape.Stylesheet[] {
    const text = css("--text") || "#d6d3c0";
    const muted = css("--muted") || "#8a927c";
    const panel = css("--elev") || "#12140f";
    const border = css("--border") || "#262920";
    const accent = css("--accent") || "#e6a13c";
    return [
      {
        selector: 'node[kind="entity"]',
        style: {
          shape: "ellipse",
          "background-color": "data(color)",
          width: 20,
          height: 20,
          label: "data(label)",
          "font-size": 8,
          color: text,
          "text-valign": "bottom",
          "text-margin-y": 3,
          "text-max-width": "120px",
          "text-wrap": "ellipsis",
          "font-family": "ui-monospace, Menlo, monospace",
        },
      },
      {
        selector: 'node[kind="activity"]',
        style: {
          shape: "round-rectangle",
          "background-color": panel,
          "border-width": 1,
          "border-color": border,
          label: "data(label)",
          color: text,
          "font-size": 8,
          "text-valign": "center",
          width: "label",
          height: 18,
          "padding-left": "6px",
          "padding-right": "6px",
        } as cytoscape.Css.Node,
      },
      {
        selector: "edge",
        style: {
          width: 1.1,
          "line-color": muted,
          "target-arrow-color": muted,
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.7,
          "curve-style": "bezier",
          opacity: 0.75,
        },
      },
      { selector: 'edge[rel="used"]', style: { "line-style": "dashed" } },
      {
        selector: 'edge[rel="invalidated"]',
        style: { "line-style": "dashed", "line-color": "#d9675f", "target-arrow-color": "#d9675f" },
      },
      {
        selector: 'edge[rel="updated"]',
        style: { "line-color": "#e6a13c", "target-arrow-color": "#e6a13c" },
      },
      {
        selector: 'edge[rel="erel"]',
        style: {
          "line-style": "dotted",
          "line-color": "#a07bd1",
          "target-arrow-color": "#a07bd1",
          "target-arrow-shape": "vee",
          label: "data(erel)",
          "font-size": 7,
          color: muted,
          "text-rotation": "autorotate",
        },
      },
      {
        selector: 'node[kind="file"]',
        style: {
          shape: "rectangle",
          "background-color": FILE_COLOR,
          width: 14,
          height: 18,
          label: "data(label)",
          "font-size": 7,
          color: muted,
          "text-valign": "bottom",
          "text-margin-y": 2,
          "text-max-width": "160px",
          "text-wrap": "ellipsis",
          "font-family": "ui-monospace, Menlo, monospace",
        },
      },
      {
        selector: 'node[kind="mount"]',
        style: {
          shape: "barrel",
          "background-color": MOUNT_COLOR,
          width: 46,
          height: 34,
          label: "data(label)",
          "font-size": 9,
          "font-weight": "bold",
          color: text,
          "text-valign": "bottom",
          "text-margin-y": 3,
          "text-wrap": "wrap",
          "text-max-width": "180px",
        },
      },
      { selector: 'edge[op="open"], edge[op="meta"]', style: { "line-style": "dotted" } },
      {
        selector: 'edge[kind="ioagg"]',
        style: { "line-color": "data(color)", "target-arrow-color": "data(color)", width: 1.3 },
      },
      { selector: 'edge[dir="meta"]', style: { "line-style": "dotted" } },
      { selector: 'edge[dir="any"]', style: { "target-arrow-shape": "none" } },
      { selector: 'edge[op="delete"]', style: { "line-style": "dashed" } },
      {
        selector: 'edge[rel="stored_in"]',
        style: {
          "line-style": "dotted",
          "line-color": FILE_COLOR,
          "target-arrow-shape": "none",
          width: 1,
        },
      },
      {
        selector: 'edge[rel="on"]',
        style: {
          "line-color": MOUNT_COLOR,
          "target-arrow-shape": "none",
          width: 0.8,
          opacity: 0.5,
        },
      },
      { selector: "node[?unreg]", style: { "background-color": css("--danger") || "#d1524e" } },
      { selector: ".faded", style: { opacity: 0.08 } },
      { selector: "node.up", style: { "border-width": 3, "border-color": "#4e9fd6", opacity: 1 } },
      {
        selector: "node.down",
        style: { "border-width": 3, "border-color": "#d9675f", opacity: 1 },
      },
      {
        selector: "edge.up",
        style: { "line-color": "#4e9fd6", "target-arrow-color": "#4e9fd6", width: 2, opacity: 1 },
      },
      {
        selector: "edge.down",
        style: { "line-color": "#d9675f", "target-arrow-color": "#d9675f", width: 2, opacity: 1 },
      },
      {
        selector: "node.pick",
        style: {
          "border-width": 5,
          "border-color": accent,
          width: 30,
          height: 30,
          opacity: 1,
          "z-index": 10,
        },
      },
    ];
  }

  function layout(eles?: cytoscape.Collection) {
    if (!cy) return;
    const target = eles ?? cy.elements(":visible");
    target
      .layout({
        name: "dagre",
        rankDir: "LR",
        nodeSep: 14,
        rankSep: 70,
        animate: false,
      } as cytoscape.LayoutOptions)
      .run();
    cy.fit(target, 30);
  }

  function build(d: ProvGraphResponse) {
    const col = colorOf();
    const els: cytoscape.ElementDefinition[] = [];
    const known = new Set<string>();
    for (const e of d.entities) {
      known.add(e.hash);
      els.push({
        data: {
          id: e.hash,
          kind: "entity",
          etype: e.type,
          label: e.type,
          eid: entityLabel(e),
          hex: e.id,
          store: e.store,
          uri: e.uri,
          color: col.get(e.type),
        },
      });
    }
    const addUnknown = (h: string) => {
      if (known.has(h)) return;
      known.add(h);
      els.push({
        data: {
          id: h,
          kind: "entity",
          etype: "(unregistered)",
          label: "unregistered",
          eid: h,
          store: "?",
          uri: "",
          unreg: true,
        },
      });
    };
    for (const a of d.activities) {
      const id = "A:" + a.aid;
      els.push({
        data: {
          id,
          kind: "activity",
          label: a.name,
          atype: a.activity,
          pid: a.pid,
          dur: a.dur,
          nused: a.used.length,
          ngen: a.generated.length,
        },
      });
      a.used.forEach((h) => {
        addUnknown(h);
        els.push({ data: { source: h, target: id, rel: "used" } });
      });
      a.generated.forEach((h) => {
        addUnknown(h);
        els.push({ data: { source: id, target: h, rel: "generated" } });
      });
      (a.invalidated ?? []).forEach((h) => {
        addUnknown(h);
        els.push({ data: { source: id, target: h, rel: "invalidated" } });
      });
      (a.updated ?? []).forEach((h) => {
        addUnknown(h);
        els.push({ data: { source: id, target: h, rel: "updated" } });
      });
    }
    // Files and storage. File identity is the absolute path.
    for (const m of d.mounts ?? [])
      els.push({
        data: {
          id: "M:" + m.path,
          kind: "mount",
          label: `${m.path}\n${m.fstype}`,
          mpath: m.path,
          fstype: m.fstype,
        },
      });
    for (const f of d.files ?? []) {
      els.push({
        data: {
          id: fileId(f.path),
          kind: "file",
          label: f.rel,
          rel: f.rel,
          mount: f.mount,
          path: f.path,
          fhash: f.fhash,
        },
      });
      els.push({ data: { source: fileId(f.path), target: "M:" + f.mount, rel: "on" } });
    }
    els.push(...ioEdges(d));
    // entity -> entity relations (ER records): contains, derived_from, ...
    for (const r of d.entity_relations ?? []) {
      addUnknown(r.subject);
      addUnknown(r.object);
      els.push({ data: { source: r.subject, target: r.object, rel: "erel", erel: r.relation } });
    }
    for (const ef of d.entity_files ?? [])
      els.push({ data: { source: ef.entity, target: fileId(ef.path), rel: "stored_in" } });
    cy = cytoscape({ container: host, elements: els, style: style(), wheelSensitivity: 0.25 });
    cy.on("tap", "node", (ev) => showDetail(ev.target));
    cy.on("tap", (ev) => {
      if (ev.target === cy) setDetail(null);
    });
    // No layout here: the caller applies the default filters first and lays
    // out only what is visible (laying out every I/O edge level is slow).
  }

  function showDetail(n: cytoscape.NodeSingular) {
    const d = n.data();
    if (d.kind === "entity") {
      const ti = typeInfo().get(d.etype);
      setDetail({
        type: d.etype,
        role: ti?.role || "—",
        "type description": ti?.description || "—",
        id: d.eid,
        store: d.store,
        uri: d.uri || "—",
        hash: d.id,
        relations:
          (n.connectedEdges('edge[rel="erel"]') as cytoscape.EdgeCollection)
            .map((e) =>
              e.source().id() === d.id
                ? `${e.data("erel")} → ${e.target().data("etype")}: ${e.target().data("eid")}`
                : `← ${e.data("erel")} by ${e.source().data("etype")}: ${e.source().data("eid")}`,
            )
            .join("; ") || "—",
        "produced by":
          n
            .incomers("node")
            .map((x) => x.data("label"))
            .join(", ") || "— (root)",
        "used by":
          n
            .outgoers("node")
            .map((x) => x.data("label"))
            .join(", ") || "— (leaf)",
      });
    } else if (d.kind === "file") {
      const acts = new Map((data()?.activities ?? []).map((a) => [a.aid, a.name]));
      const rows = (data()?.accesses ?? []).filter((x) => x.path === d.path);
      const io = (want: (op: string) => boolean) =>
        rows
          .filter((x) => want(x.op))
          .map((x) => `${acts.get(x.aid) ?? x.aid} (${x.op}, ${x.calls}×, ${fmtBytes(x.bytes)})`)
          .join("; ");
      setDetail({
        file: d.rel,
        storage: d.mount,
        "full path": d.path,
        "read by": io((o) => o === "read") || "—",
        "written by": io((o) => o === "write") || "—",
        "metadata by": io((o) => !DATA_OPS.has(o)) || "—",
        entities:
          (n.incomers('edge[rel="stored_in"]') as cytoscape.EdgeCollection)
            .map((e) => `${e.source().data("etype")}: ${e.source().data("eid")}`)
            .join("; ") || "—",
      });
    } else if (d.kind === "mount") {
      setDetail({
        storage: d.mpath,
        filesystem: d.fstype,
        files: String(n.incomers("node").length),
      });
    } else {
      const mine = (data()?.accesses ?? []).filter((x) => "A:" + x.aid === d.id);
      const files = (op: string) =>
        new Set(mine.filter((x) => x.op === op).map((x) => x.path)).size;
      const sum = (op: string) => mine.filter((x) => x.op === op).reduce((t, x) => t + x.bytes, 0);
      setDetail({
        activity: d.label,
        type: d.atype,
        pid: String(d.pid),
        duration: `${(d.dur / 1e3).toFixed(2)} ms`,
        used: String(d.nused),
        generated: String(d.ngen),
        "files read": `${files("read")} (${fmtBytes(sum("read"))})`,
        "files written": `${files("write")} (${fmtBytes(sum("write"))})`,
      });
    }
  }

  // Upstream / downstream over provenance edges (used, generated) only, so the
  // answer does not depend on which I/O link mode is displayed.
  function provWalk(start: cytoscape.CollectionReturnValue, up: boolean) {
    const seen = new Set<string>(start.map((n) => n.id()));
    const out: string[] = [];
    let frontier = start.nodes();
    while (frontier.length) {
      const edges = (up ? frontier.incomers("edge") : frontier.outgoers("edge")).filter(
        '[rel="used"], [rel="generated"], [rel="updated"]',
      ) as cytoscape.EdgeCollection;
      const next = (up ? edges.sources() : edges.targets()).filter((n) => !seen.has(n.id()));
      next.forEach((n) => {
        seen.add(n.id());
        out.push(n.id());
      });
      frontier = next;
    }
    const nodes = cy!.collection(out.map((id) => cy!.getElementById(id)));
    const edges = nodes
      .union(start)
      .connectedEdges('[rel="used"], [rel="generated"], [rel="updated"]')
      .filter((e) => seen.has(e.source().id()) && seen.has(e.target().id()));
    return nodes.union(edges);
  }
  // Files the given activities touched and entities stored in, with storage.
  function filesOf(c: cytoscape.CollectionReturnValue) {
    const acts = c.nodes('[kind="activity"]');
    const ents = c.nodes('[kind="entity"]');
    const ioE = acts.connectedEdges('[kind="ioagg"]');
    const stE = ents.outgoers('edge[rel="stored_in"]');
    const files = ioE.connectedNodes('[kind="file"]').union(stE.targets());
    const onE = files.outgoers('edge[rel="on"]');
    return files.union(ioE).union(stE).union(onE).union(onE.targets());
  }

  function clearTrace() {
    cy?.elements().removeClass("up down pick faded");
    setSel(null);
  }

  function trace() {
    if (!cy) return;
    clearTrace();
    const p = cy.collection(picked().map((h) => cy!.getElementById(h)));
    const upP = provWalk(p, true);
    const downP = provWalk(p, false);
    const up = upP.union(filesOf(upP));
    const down = downP.union(filesOf(downP.union(p)));
    cy.elements().addClass("faded");
    up.removeClass("faded").addClass("up");
    down.removeClass("faded").addClass("down");
    p.removeClass("faded").addClass("pick");
    layout(up.union(down).union(p));
    const upE = up.nodes('[kind="entity"]');
    const touched = up.union(down).nodes('[kind="file"]');
    setSel({
      picked: p.length,
      up: upE.length,
      down: down.nodes('[kind="entity"]').length,
      roots: upE
        .filter((n) => n.incomers("node").length === 0)
        .map((n) => ({ type: n.data("etype"), id: n.data("eid") })),
      upTypes: count(upE),
      downTypes: count(down.nodes('[kind="entity"]')),
      files: touched.length,
      storage: [
        ...new Set(
          up
            .union(down)
            .union(p)
            .nodes('[kind="file"]')
            .map((f) => f.data("mount") as string),
        ),
      ],
    });
  }

  // Perfetto-style navigation with the same keys the timeline uses: A/D pan,
  // W/S zoom at the pointer, arrows as aliases. Held keys repeat per frame.
  const NAV_KEYS = new Set(["w", "a", "s", "d", "arrowleft", "arrowright", "arrowup", "arrowdown"]);
  const keys = new Set<string>();
  let pointer = { x: 0, y: 0 };
  let navFrame = 0;

  const navApply = () => {
    if (!cy) return;
    const box = host.getBoundingClientRect();
    const at = { x: pointer.x || box.width / 2, y: pointer.y || box.height / 2 };
    const level = cy.zoom();
    if (keys.has("w") || keys.has("arrowup")) {
      cy.zoom({ level: level * 1.04, renderedPosition: at });
    }
    if (keys.has("s") || keys.has("arrowdown")) {
      cy.zoom({ level: level / 1.04, renderedPosition: at });
    }
    const dx = Math.max(1, box.width * 0.02);
    if (keys.has("a") || keys.has("arrowleft")) cy.panBy({ x: dx, y: 0 });
    if (keys.has("d") || keys.has("arrowright")) cy.panBy({ x: -dx, y: 0 });
  };

  const navStep = () => {
    if (!cy || keys.size === 0) {
      navFrame = 0;
      return;
    }
    navApply();
    navFrame = requestAnimationFrame(navStep);
  };

  const isEditable = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));

  const onNavDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!NAV_KEYS.has(k) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.target)) return;
    e.preventDefault();
    const fresh = !keys.has(k);
    keys.add(k);
    if (fresh) navApply(); // a tap must move the view, not just a held key
    if (!navFrame) navFrame = requestAnimationFrame(navStep);
  };
  const onNavUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
  };
  const onNavBlur = () => keys.clear();
  const onNavMove = (e: MouseEvent) => {
    const box = host.getBoundingClientRect();
    pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  onMount(() => {
    window.addEventListener("keydown", onNavDown);
    window.addEventListener("keyup", onNavUp);
    window.addEventListener("blur", onNavBlur);
    host.addEventListener("mousemove", onNavMove);
    host.addEventListener("wheel", onNavMove, { passive: true });
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onNavDown);
    window.removeEventListener("keyup", onNavUp);
    window.removeEventListener("blur", onNavBlur);
    host.removeEventListener("mousemove", onNavMove);
    host.removeEventListener("wheel", onNavMove);
    if (navFrame) cancelAnimationFrame(navFrame);
    keys.clear();
  });

  async function loadGraph() {
    setLoading(true);
    try {
      const d = await fetchProvGraph({}, props.scope, ctrl.signal);
      clearTrace();
      setPicked([]);
      setPtype("");
      cy?.destroy();
      cy = undefined;
      setData(d);
      if (d.entities.length || d.activities.length) {
        build(d);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  onMount(loadGraph);
  // This view is for tracing, so new data waits here for the user rather than moving the graph under them.
  const newRecords = () => {
    const d = data();
    const l = props.live.data();
    return d && l
      ? l.activities.length - d.activities.length + (l.entities.length - d.entities.length)
      : 0;
  };
  // Re-read the theme tokens when the app's dark/light mode flips.
  createEffect(
    on(
      () => props.mode,
      () => cy?.style(style()),
      { defer: true },
    ),
  );

  return (
    <div class="prov">
      <aside class="prov-rail">
        <Show when={error()}>
          <div class="prov-error">Could not load the provenance graph: {error()}</div>
        </Show>
        <Show
          when={data()}
          fallback={
            <Show when={!error()}>
              <div class="muted">Scanning trace for provenance records…</div>
            </Show>
          }
        >
          {(d) => (
            <>
              <section>
                <h3>Trace</h3>
                <dl class="prov-stats">
                  <dt>entities</dt>
                  <dd>{d().stats.entities}</dd>
                  <dt>activities</dt>
                  <dd>{d().stats.activities}</dd>
                  <dt>dangling</dt>
                  <dd classList={{ bad: d().stats.dangling_hashes > 0 }}>
                    {d().stats.dangling_hashes}
                  </dd>
                  <dt>isolated</dt>
                  <dd>{d().stats.isolated_entities}</dd>
                  <Show when={d().stats.files !== undefined}>
                    <dt>files</dt>
                    <dd>{d().stats.files}</dd>
                    <dt>storage</dt>
                    <dd>{d().stats.mounts}</dd>
                    <dt>I/O calls in activities</dt>
                    <dd>{d().stats.io_attributed}</dd>
                  </Show>
                  <dt>truncated</dt>
                  <dd classList={{ bad: d().stats.truncated_activities > 0 }}>
                    {d().stats.truncated_activities}
                  </dd>
                </dl>
                <Show when={!d().stats.entities && !d().stats.activities}>
                  <p class="muted">
                    No provenance records in this trace. Record them with dftracer_prov
                    (DFT_PROV_ACTIVITY / prov.activity) and run with DFTRACER_INC_METADATA=1.
                  </p>
                </Show>
              </section>
              <section class="prov-trace">
                <h3>Trace entities</h3>
                <label for="prov-type">Entity type</label>
                <select
                  id="prov-type"
                  value={ptype()}
                  onChange={(e) => {
                    setPtype(e.currentTarget.value);
                    setPicked([]);
                  }}
                >
                  <option value="">Choose a type…</option>
                  <Show when={(d().files ?? []).length}>
                    <option value="(file)">(file) ({d().files!.length})</option>
                    <option value="(storage)">(storage) ({(d().mounts ?? []).length})</option>
                  </Show>
                  <For each={types()}>
                    {(t) => (
                      <option value={t.t}>
                        {t.t} ({t.n})
                      </option>
                    )}
                  </For>
                </select>
                <label for="prov-ids">Entity ids</label>
                <select
                  id="prov-ids"
                  multiple
                  size={7}
                  disabled={!ptype()}
                  onChange={(e) =>
                    setPicked([...e.currentTarget.selectedOptions].map((o) => o.value))
                  }
                >
                  <For each={idsOfType()}>
                    {(e) => (
                      <option value={e.hash} selected={picked().includes(e.hash)}>
                        {e.id}
                      </option>
                    )}
                  </For>
                </select>
                <div class="prov-row">
                  <button
                    type="button"
                    disabled={!ptype()}
                    onClick={() => setPicked(idsOfType().map((e) => e.hash))}
                  >
                    Select all
                  </button>
                  <button type="button" class="primary" disabled={!picked().length} onClick={trace}>
                    Trace lineage + impact
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearTrace();
                      setPicked([]);
                      layout();
                    }}
                  >
                    Clear
                  </button>
                </div>
                <div class="prov-keys">
                  <span>
                    <i class="k up" />
                    lineage
                  </span>
                  <span>
                    <i class="k pick" />
                    selected
                  </span>
                  <span>
                    <i class="k down" />
                    impact
                  </span>
                </div>
                <Show when={sel()}>
                  {(s) => (
                    <div class="prov-result">
                      <p>
                        <b>{s().picked}</b> selected · <b>{s().up}</b> upstream · <b>{s().down}</b>{" "}
                        downstream entities · <b>{s().files}</b> files
                      </p>
                      <h4 class="up">Derived from</h4>
                      <ul>
                        <For each={s().upTypes} fallback={<li>nothing (selection is a root)</li>}>
                          {([t, n]) => (
                            <li>
                              {t} × {n}
                            </li>
                          )}
                        </For>
                      </ul>
                      <h4>Root inputs</h4>
                      <ul>
                        <For each={s().roots} fallback={<li>none</li>}>
                          {(r) => (
                            <li>
                              {r.type}: {r.id}
                            </li>
                          )}
                        </For>
                      </ul>
                      <h4>Storage touched</h4>
                      <ul>
                        <For each={s().storage} fallback={<li>none</li>}>
                          {(m) => <li>{m}</li>}
                        </For>
                      </ul>
                      <h4 class="down">Affects</h4>
                      <ul>
                        <For each={s().downTypes} fallback={<li>nothing downstream</li>}>
                          {([t, n]) => (
                            <li>
                              {t} × {n}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </Show>
              </section>
            </>
          )}
        </Show>
      </aside>
      <div class="prov-canvas">
        <Show when={newRecords() > 0}>
          <div class="prov-stale">
            {newRecords().toLocaleString()} new records since this graph was drawn
            <button type="button" disabled={loading()} onClick={() => void loadGraph()}>
              {loading() ? "Loading…" : "Refresh"}
            </button>
          </div>
        </Show>
        <div ref={host} class="prov-cy" role="img" aria-label="Provenance graph" />
        <Show when={detail()}>
          {(d) => (
            <div class="prov-detail">
              <dl>
                <For each={Object.entries(d())}>
                  {([k, v]) => (
                    <>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </>
                  )}
                </For>
              </dl>
            </div>
          )}
        </Show>
        <div class="prov-hint">
          Click a node for details · ellipse: entity · box: activity · square: file · barrel:
          storage · arrows: generated / used (dashed) / read / write
        </div>
      </div>
    </div>
  );
}
