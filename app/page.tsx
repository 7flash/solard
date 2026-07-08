export default function HomePage() {
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Solwal local trading console</p>
          <h1>Wallets, groups, launches, trades.</h1>
          <p className="muted">
            Run this only on a trusted local machine. Browser actions can sign
            transactions through your encrypted local Solwal wallet store.
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
          Overview
        </button>
        <button data-tab="wallets">Wallets & groups</button>
        <button data-tab="terminal">Pump terminal</button>
        <button data-tab="launch">Launch pump</button>
        <button data-tab="trade">Trade</button>
        <button data-tab="jobs">Jobs</button>
      </nav>

      <section id="app-root" className="panel">
        Loading console…
      </section>
    </main>
  );
}
