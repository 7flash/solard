import type { PumpFeedRow, State } from "./state.ts";

export type KeyboardShortcutOptions = {
  getTab: () => State["tab"];
  getSelectedTerminalRow: () => PumpFeedRow | null;
  onRefresh: () => void;
  onPin: (row: PumpFeedRow) => void;
  onBuy: (row: PumpFeedRow) => void;
};

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName?.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    Boolean(element?.isContentEditable)
  );
}

export function installKeyboardShortcuts(
  options: KeyboardShortcutOptions,
): () => void {
  const keydown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target) && event.key !== "Escape") return;

    const tab = options.getTab();
    if (tab === "terminal" && event.key === "/") {
      event.preventDefault();
      document
        .querySelector<HTMLInputElement>(
          'input[placeholder*="filter"], input[aria-label*="filter" i]',
        )
        ?.focus();
      return;
    }

    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      options.onRefresh();
      return;
    }

    if (tab !== "terminal") return;
    const selected = options.getSelectedTerminalRow();
    if (!selected) return;

    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      options.onPin(selected);
      return;
    }

    if (event.key.toLowerCase() === "b") {
      event.preventDefault();
      options.onBuy(selected);
    }
  };

  window.addEventListener("keydown", keydown);
  return () => window.removeEventListener("keydown", keydown);
}
