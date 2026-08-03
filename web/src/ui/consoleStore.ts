import { createSignal } from "solid-js";

const OPEN_KEY = "dfd.console.open";

export const [consoleOpen, setConsoleOpen] = createSignal(localStorage.getItem(OPEN_KEY) === "1");
export const [unreadErrors, setUnreadErrors] = createSignal(0);

export function toggleConsole() {
  const v = !consoleOpen();
  setConsoleOpen(v);
  localStorage.setItem(OPEN_KEY, v ? "1" : "0");
  if (v) setUnreadErrors(0);
}

// Count errors seen while the console is closed, for the status-bar badge.
export function noteError() {
  if (!consoleOpen()) setUnreadErrors((n) => n + 1);
}
