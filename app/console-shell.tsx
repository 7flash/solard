type ConsolePage =
  | "overview"
  | "terminal"
  | "watchlists"
  | "signals"
  | "launch"
  | "wallets"
  | "portfolio"
  | "trade"
  | "jobs";

/**
 * Backwards-compatible shim only.
 * The real app frame belongs in app/layout.tsx. Do not render a nested shell here.
 * Older route files that still import ConsoleShell will now mount only the page host.
 */
export function ConsoleShell(args: {
  page: ConsolePage;
  heading?: string;
  description?: string;
  eyebrow?: string;
}) {
  return (
    <section id="app-root" data-page={args.page} className="client-root">
      Loading {args.heading ?? args.page}…
    </section>
  );
}
