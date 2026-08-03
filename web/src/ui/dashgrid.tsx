import { For, Show, createSignal, type Accessor, type JSX } from "solid-js";

export interface Pos {
  x: number; // 1-based column start
  y: number; // 1-based row start
  w: number; // width in columns
  h: number; // height in row units
}
export type DashLayout = Record<string, Pos>;

const COLS = 6;
const ROW = 150; // px per row unit (matches .dash-grid grid-auto-rows)
const GAP = 14;

function overlap(a: Pos, b: Pos): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Anchor `movedId`, bump the rest down to eliminate overlaps. Deterministic,
// no overlaps, terminates.
function resolveCollisions(layout: DashLayout, movedId: string): DashLayout {
  const out: DashLayout = {};
  for (const k of Object.keys(layout)) out[k] = { ...layout[k] };
  const ids = Object.keys(out).sort((a, b) => {
    if (a === movedId) return -1;
    if (b === movedId) return 1;
    return out[a].y - out[b].y || out[a].x - out[b].x;
  });
  const placed: string[] = [];
  for (const id of ids) {
    let bumped = true;
    while (bumped) {
      bumped = false;
      for (const pid of placed) {
        if (overlap(out[id], out[pid])) {
          out[id].y = out[pid].y + out[pid].h;
          bumped = true;
        }
      }
    }
    placed.push(id);
  }
  return out;
}

export interface DashState {
  cards: string[];
  layout: DashLayout;
}

// Manages the shown card set + geometry. `onChange` is called after every edit
// so the caller can persist (localStorage + server). `hydrate` loads a saved
// state (e.g. from the server) after mount.
export function createDashboard(opts: {
  defaults: DashState;
  initial?: DashState | null;
  onChange?: (s: DashState) => void;
}) {
  const valid = (s?: DashState | null): s is DashState =>
    !!s && Array.isArray(s.cards) && !!s.layout;
  const start = valid(opts.initial) ? opts.initial : opts.defaults;
  const [cards, setCards] = createSignal<string[]>([...start.cards]);
  const [layout, setLayout] = createSignal<DashLayout>({ ...start.layout });
  const emit = () => opts.onChange?.({ cards: cards(), layout: layout() });

  const hydrate = (s: DashState) => {
    if (!valid(s)) return;
    setCards([...s.cards]);
    setLayout({ ...s.layout });
  };
  const setPos = (id: string, pos: Pos) => {
    setLayout((prev) => resolveCollisions({ ...prev, [id]: pos }, id));
    emit();
  };
  const addCard = (id: string, pos: Pos) => {
    if (cards().includes(id)) return;
    setCards((c) => [...c, id]);
    setLayout((prev) => resolveCollisions({ ...prev, [id]: pos }, id));
    emit();
  };
  const removeCard = (id: string) => {
    setCards((c) => c.filter((x) => x !== id));
    setLayout((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    emit();
  };
  const reset = () => {
    hydrate(opts.defaults);
    emit();
  };
  return { cards, layout, setPos, addCard, removeCard, reset, hydrate };
}

export function DashGrid(props: {
  editing: boolean;
  layout: Accessor<DashLayout>;
  setPos: (id: string, pos: Pos) => void;
  onRemove?: (id: string) => void;
  items: { id: string; el: JSX.Element }[];
}) {
  let grid!: HTMLDivElement;
  const stepX = () => (grid.getBoundingClientRect().width - (COLS - 1) * GAP) / COLS + GAP;
  const posOf = (id: string): Pos => props.layout()[id] ?? { x: 1, y: 1, w: 2, h: 2 };

  function track(
    e: PointerEvent,
    id: string,
    apply: (dCol: number, dRow: number, start: Pos) => Pos,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const start = posOf(id);
    const sx = e.clientX;
    const sy = e.clientY;
    const sX = stepX();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dCol = Math.round((ev.clientX - sx) / sX);
      const dRow = Math.round((ev.clientY - sy) / (ROW + GAP));
      props.setPos(id, apply(dCol, dRow, start));
    };
    const up = () => {
      handle.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  const onMove = (e: PointerEvent, id: string) =>
    track(e, id, (dCol, dRow, s) => ({
      w: s.w,
      h: s.h,
      x: clamp(s.x + dCol, 1, COLS - s.w + 1),
      y: Math.max(1, s.y + dRow),
    }));

  // Resize from any corner: left/top corners move the edge (change x/y and w/h),
  // right/bottom corners just grow w/h. Clamp so w,h >= 1 and stay on the grid.
  const onResize = (e: PointerEvent, id: string, corner: string) =>
    track(e, id, (dCol, dRow, s) => {
      const left = corner === "nw" || corner === "sw";
      const top = corner === "nw" || corner === "ne";
      let x = left ? s.x + dCol : s.x;
      let y = top ? s.y + dRow : s.y;
      let w = left ? s.w - dCol : s.w + dCol;
      let h = top ? s.h - dRow : s.h + dRow;
      if (w < 1) {
        if (left) x -= 1 - w;
        w = 1;
      }
      if (h < 1) {
        if (top) y -= 1 - h;
        h = 1;
      }
      if (x < 1) {
        if (left) w -= 1 - x;
        x = 1;
      }
      if (y < 1) {
        if (top) h -= 1 - y;
        y = 1;
      }
      if (x + w > COLS + 1) w = COLS + 1 - x;
      return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    });

  const CORNERS = ["nw", "ne", "sw", "se"];

  return (
    <div class="dash-grid" classList={{ editing: props.editing }} ref={grid}>
      <For each={props.items}>
        {(it) => {
          const shown = () => !!props.layout()[it.id];
          const p = () => posOf(it.id);
          return (
            <div
              class="dash-cell"
              style={
                shown()
                  ? {
                      "grid-column": `${p().x} / span ${p().w}`,
                      "grid-row": `${p().y} / span ${p().h}`,
                    }
                  : { display: "none" }
              }
            >
              {it.el}
              <Show when={props.editing}>
                <div
                  class="dash-move"
                  title="Drag to move"
                  onPointerDown={(e) => onMove(e, it.id)}
                />
                <Show when={props.onRemove}>
                  <button
                    type="button"
                    class="dash-remove"
                    title="Remove card"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => props.onRemove?.(it.id)}
                  >
                    x
                  </button>
                </Show>
                <For each={CORNERS}>
                  {(cn) => (
                    <div
                      class={`dash-resize ${cn}`}
                      title="Drag to resize"
                      onPointerDown={(e) => onResize(e, it.id, cn)}
                    />
                  )}
                </For>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
