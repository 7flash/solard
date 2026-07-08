export type ConsolePage =
  | "overview"
  | "terminal"
  | "watchlists"
  | "signals"
  | "launch"
  | "wallets"
  | "portfolio"
  | "trade"
  | "jobs";

const LABELS: Record<ConsolePage, string> = {
  overview: "home",
  terminal: "terminal",
  watchlists: "watchlists",
  signals: "signals",
  launch: "launch",
  wallets: "wallets",
  portfolio: "portfolio",
  trade: "trade",
  jobs: "activity",
};

/**
 * The server route entry point is intentionally tiny.
 * All real page headers and interactive UI live in the client runtime so every
 * route hard-refreshes through the same mount contract.
 */
export function PageHost({ page }: { page: ConsolePage }) {
  return (
    <section id="app-root" data-page={page} className="client-root">
      Loading {LABELS[page]}…
    </section>
  );
}
