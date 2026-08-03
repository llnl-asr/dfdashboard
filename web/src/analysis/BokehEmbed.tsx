import { createEffect, onCleanup } from "solid-js";
import { apiUrl } from "../data/api";

// Embeds a live Panel-served Bokeh session inline (no iframe); re-embeds on
// `task` change to stream that task's partial results.
export default function BokehEmbed(props: { task?: string; class?: string }) {
  let host: HTMLDivElement | undefined;

  createEffect(async () => {
    const task = props.task ?? "";
    if (!host) return;
    host.innerHTML = "";
    const q = task ? `?task=${encodeURIComponent(task)}` : "";
    const { script } = (await (await fetch(apiUrl(`/api/panel/embed${q}`))).json()) as {
      script: string;
    };
    if (!host) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = script.trim();
    const src = tpl.content.querySelector("script");
    if (!src) return;
    const el = document.createElement("script");
    for (const attr of Array.from(src.attributes)) el.setAttribute(attr.name, attr.value);
    el.textContent = src.textContent;
    host.appendChild(el);
  });

  onCleanup(() => {
    if (host) host.innerHTML = "";
  });

  return <div ref={host} class={props.class} />;
}
