export default function Page() {
  return (
    <main className="shell page-shell" data-page="overview">
      <aside className="side-nav">
        <div className="brand-block">
          <p className="eyebrow">SOLARD</p>
          <h1>HOME</h1>
        </div>
        <nav className="nav-list" id="main-nav">
          <a data-page="overview" className="active" href="/">
            Home
          </a>
          <a data-page="terminal" className="" href="/terminal">
            Pump terminal
          </a>
          <a data-page="watchlists" className="" href="/watchlists">
            Watchlists
          </a>
          <a data-page="signals" className="" href="/signals">
            Signals
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
            <p className="eyebrow">SOLARD // LOCAL COMMAND CONSOLE</p>
            <h2>Terminal. Wallets. Launches.</h2>
            <p className="muted">
              Control surface for live Pump streams, watchlists, wallet groups,
              launch plans, trades, and run activity.
            </p>
          </div>
        </header>
        <section id="app-root" data-page="overview" className="panel">
          Loading console…
        </section>
      </section>
    </main>
  );
}
