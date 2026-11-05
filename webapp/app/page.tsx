/** @jsxImportSource tradjs/client */
/** One page with everything. The server renders the frame; page.client.tsx fills it from /api/overview (every 3s)
 * and /api/coin (the selected coin, every 2s). The selected coin lives in the URL (?coin=<mint>). */
export default function Page() {
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><b>SOLARD</b></div>
        <div id="stats" className="stats">loading…</div>
        <input id="search" className="search" placeholder="Paste a mint to open it" autoComplete="off" />
      </header>
      <main className="grid">
        <section className="card positions"><div className="card-head"><h2>Positions</h2><span id="pos-sub" className="dim"></span>
          <div className="grow" /><div className="tabs" id="pos-filter"><button data-f="all" className="on">All</button><button data-f="holding">Holding</button><button data-f="smart">Smart</button><button data-f="losing">Losing</button></div></div>
          <div className="scroll" id="positions" />
          <div className="card-head closed-head"><h2>Closed</h2><span id="closed-sub" className="dim"></span></div><div className="scroll closed-list" id="closed" /></section>
        <section className="card coin"><div className="card-head"><h2 id="coin-title">Select a coin</h2><span id="coin-links" className="dim"></span></div>
          <div id="coin-stats" className="coin-stats" />
          <canvas id="map" className="map" />
          <div className="split"><div className="scroll" id="coin-wallets" /><div className="scroll" id="coin-trades" /></div></section>
        <section className="card side"><div className="card-head"><h2>New · bonding curve</h2><span id="new-sub" className="dim"></span></div><div className="scroll short" id="disc-new" />
          <div className="card-head"><h2>Migrated</h2><span id="mig-sub" className="dim"></span></div><div className="scroll short" id="disc-mig" /></section>
      </main>
      <div id="tip" className="tip" />
    </div>
  );
}
