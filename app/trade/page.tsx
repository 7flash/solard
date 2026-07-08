export default function Page() {
  return (
    <main className="shell page-shell" data-page="trade">
      <aside className="side-nav">
        <div className="brand-block">
          <p className="eyebrow">SOLWAL</p>
          <h1>TRADE</h1>
        </div>
        <nav className="nav-list" id="main-nav">
          <a data-page="overview" className="" href="/">
            Home
          </a>
          <a data-page="terminal" className="" href="/terminal">
            Pump terminal
          </a>
          <a data-page="watchlists" className="" href="/watchlists">
            Watchlists
          </a>
          <a data-page="launch" className="" href="/launch">
            Launch
          </a>
          <a data-page="wallets" className="" href="/wallets">
            Wallets
          </a>
          <a data-page="trade" className="active" href="/trade">
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
            <h2>Manual token trading.</h2>
            <p className="muted">
              Run dry-run or live buys and sells through the Solwal SDK.
            </p>
          </div>
        </header>
        <section id="app-root" data-page="trade" className="panel">
          Loading console…
        </section>
      </section>
    </main>
  );
}
