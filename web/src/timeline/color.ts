// Curated qualitative palette tuned for the dark timeline surface. Ordered for
// separation between neighbours; assigned to names in first-seen order so a name
// keeps its color across queries (color follows the entity, not its rank).
const PALETTE = [
  "#4bb0c4",
  "#e6a13c",
  "#5f7d52",
  "#b06fc4",
  "#d1524e",
  "#5b8fd1",
  "#9aa84e",
  "#c98a5a",
  "#6fb3a0",
  "#c76f96",
  "#8f9bd6",
  "#b3924e",
  "#7fb36a",
  "#d0a24e",
  "#9a7bc4",
  "#6aa9bf",
];

const assigned = new Map<string, string>();
let nextSlot = 0;

export function colorFor(key: string): string {
  let c = assigned.get(key);
  if (c) return c;
  c = PALETTE[nextSlot % PALETTE.length];
  nextSlot += 1;
  assigned.set(key, c);
  return c;
}

// Pick readable label ink for a given slice fill (dark on bright hues, light on
// dark hues).
export function contrastText(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "rgba(10,12,18,0.95)" : "rgba(255,255,255,0.95)";
}

// Color/legend key for an event: name first (what varies per slice), falling
// back to category. Matches Perfetto's per-name coloring.
export function sliceKey(ev: { name?: unknown; cat?: unknown }): string {
  const name = ev.name != null ? String(ev.name) : "";
  const cat = ev.cat != null ? String(ev.cat) : "";
  return name || cat;
}
