export default function Page() {
  return (
    <main className="shell page-shell" data-page="watchlists">
      <aside className="side-nav">
        <div className="brand-block">
          <p className="eyebrow">SOLWAL</p>
          <h1>WATCHLISTS</h1>
        </div>
        <nav className="nav-list" id="main-nav">
          <a data-page="overview" className="" href="/">
            Home
          </a>
          <a data-page="terminal" className="" href="/terminal">
            Pump terminal
          </a>
          <a data-page="watchlists" className="active" href="/watchlists">
            Watchlists
          </a>
          <a data-page="launch" className="" href="/launch">
            Launch
          </a>
          <a data-page="wallets" className="" href="/wallets">
            Wallets
          </a>
          <a data-page="trade" className="" href="/trade">
            Trade
          </a>
          <a data-page="jobs" className="" href="/activity">
            Activity
          </a>
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
            <p className="eyebrow">SOLWAL // LOCAL COMMAND CONSOLE</p>
            <h2>Watched token grids.</h2>
            <p className="muted">
              Groups of tracked tokens with live market-cap samples, SMA
              columns, and movement sorting.
            </p>
          </div>
        </header>
        <section id="app-root" data-page="watchlists" className="panel">
          Loading console…
        </section>
      </section>
    </main>
  );
}
