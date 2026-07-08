export default function Page() {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">SOLARD // PORTFOLIO</p>
          <h2>Portfolio.</h2>
          <p className="muted">
            Wallet SOL and token holdings live here, away from Home. Refresh
            when you need full RPC-backed balances.
          </p>
        </div>
      </header>
      <section id="app-root" data-page="portfolio" className="panel">
        Loading portfolio…
      </section>
    </>
  );
}
