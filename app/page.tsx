export default function HomePage() {
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">SOLWAL // LOCAL COMMAND CONSOLE</p>
          <h1>Terminal. Wallets. Launches.</h1>
          <p className="muted">
            Flat local admin console for Pump streams, watchlists, wallet
            groups, launch plans, trades, and run activity.
          </p>
        </div>
        <div className="status-card">
          <span id="connection-status" className="pill">
            loading
          </span>
          <span id="last-refresh" className="muted small">
            —
          </span>
        </div>
      </header>

      <nav className="tabs" id="tabs">
        <button data-tab="overview" className="active">
          Home
        </button>
        <button data-tab="terminal">Pump terminal</button>
        <button data-tab="watchlists">Watchlists</button>
        <button data-tab="launch">Launch</button>
        <button data-tab="wallets">Wallets</button>
        <button data-tab="trade">Trade</button>
        <button data-tab="jobs">Activity</button>
      </nav>

      <section id="app-root" className="panel">
        Loading console…
      </section>
    </main>
  );
}
