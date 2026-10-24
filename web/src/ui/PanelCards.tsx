import { createEffect, onCleanup } from "solid-js";
import { apiUrl } from "../data/api";

// One shared Panel session; per-card roots render into `pcard-<id>` slots.
// Embeds lazily (only once `visible`) so hidden views never spin a session, then
// re-embeds (debounced) on card-set/range/query change. Renders nothing.
export function PanelEmbed(props: {
  cards: string[];
  begin?: string;
  end?: string;
  query?: string;
  nonce?: number;
  visible?: boolean;
  theme?: "dark" | "light";
}) {
  let injected: HTMLScriptElement | undefined;
  let timer: number | undefined;
  let lastKey = "";

  const embed = async (params: URLSearchParams) => {
    injected?.remove();
    injected = undefined;
    if (!params.get("cards")) return;
    const res = await fetch(apiUrl(`/api/panel/cards/embed?${params.toString()}`));
    const { script } = (await res.json()) as { script: string };
    const tpl = document.createElement("template");
    tpl.innerHTML = script.trim();
    const src = tpl.content.querySelector("script");
    if (!src) return;
    const el = document.createElement("script");
    for (const a of Array.from(src.attributes)) el.setAttribute(a.name, a.value);
    el.textContent = src.textContent;
    document.body.appendChild(el);
    injected = el;
  };

  createEffect(() => {
    const params = new URLSearchParams({ cards: props.cards.join(",") });
    if (props.begin) params.set("begin", props.begin);
    if (props.end) params.set("end", props.end);
    if (props.query) params.set("query", props.query);
    if (props.nonce) params.set("_r", String(props.nonce));
    // Cards are painted server-side, so a theme switch re-embeds them.
    if (props.theme) params.set("theme", props.theme);
    const key = params.toString();
    // Skip while hidden; re-embed only on a real param change, not a visibility toggle.
    if (props.visible === false) return;
    if (key === lastKey && injected) return;
    lastKey = key;
    clearTimeout(timer);
    timer = window.setTimeout(() => embed(params), 350);
  });

  onCleanup(() => {
    clearTimeout(timer);
    injected?.remove();
  });

  return null;
}
