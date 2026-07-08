type ConsolePage =
  | "overview"
  | "terminal"
  | "watchlists"
  | "signals"
  | "launch"
  | "wallets"
  | "trade"
  | "jobs";

const NAV: Array<{ page: ConsolePage; href: string; label: string }> = [
  { page: "overview", href: "/", label: "Home" },
  { page: "terminal", href: "/terminal", label: "Pump terminal" },
  { page: "watchlists", href: "/watchlists", label: "Watchlists" },
  { page: "signals", href: "/signals", label: "Signals" },
  { page: "launch", href: "/launch", label: "Launch" },
  { page: "wallets", href: "/wallets", label: "Wallets" },
  { page: "trade", href: "/trade", label: "Trade" },
  { page: "jobs", href: "/activity", label: "Activity" },
];

export function ConsoleShell(args: {
  page: ConsolePage;
  heading: string;
  description: string;
  eyebrow?: string;
}) {
  return (
    <main className="shell page-shell" data-page={args.page}>
      <aside className="side-nav">
        <div className="brand-block">
          <p className="eyebrow">SOLARD</p>
          <h1>{args.heading}</h1>
        </div>
        <nav className="nav-list" id="main-nav">
          {NAV.map((item) => (
            <a
              key={item.page}
              data-page={item.page}
              className={item.page === args.page ? "active" : ""}
              href={item.href}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <span id="connection-status" className="pill">
            loading
          </span>
          <span id="last-refresh" className="muted small">
            —
          </span>
        </div>
      </aside>

      <section className="main-console">
        <header className="page-header">
          <div>
            <p className="eyebrow">
              {args.eyebrow ?? "SOLARD // LOCAL COMMAND CONSOLE"}
            </p>
            <h2>{args.heading}.</h2>
            <p className="muted">{args.description}</p>
          </div>
        </header>
        <section id="app-root" data-page={args.page} className="panel">
          Loading console…
        </section>
      </section>
    </main>
  );
}
