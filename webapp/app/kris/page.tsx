/** @jsxImportSource tradjs/client */
/** The Kris room: the real terminal on a monitor, Kris sitting beside it with a cursor on the screen, Kris's thought in
 * a bubble and the history above it. A separate page: the terminal knows nothing about Kris. See page.client.tsx. */
function Figure() {
  return <canvas id="kris-figure" className="figure" width="420" height="567" role="img" aria-label="Kris at the laptop" />;
}

export default function KrisRoom() {
  return (
    <div className="room">
      <header className="room-top"><b>KRIS</b></header>
      <main className="room-main">
        <section className="thoughts">
          <div id="bubble" className="bubble" />
          <section className="history"><h2>History <span id="history-n" className="dim" /></h2><div id="history" className="history-list" /></section>
        </section>
        <section className="workstation">
          <div className="monitor">
            <div className="browser">
              <div className="tabs-row"><span className="dots"><i /><i /><i /></span><span className="tab">Solard Terminal</span></div>
              <div className="browser-bar"><span className="nav">‹</span><span className="nav">›</span><span className="nav">⟳</span><a className="address" href="https://solard.xyz/terminal?agent=kris" target="_blank" rel="noreferrer"><span className="lock">●</span> solard.xyz/terminal?agent=kris</a></div>
            </div>
            <div className="screen" id="screen">
              <iframe id="term" title="Solard terminal" src="./?embed=1&sort=last&dir=desc" /><img id="browser" alt="" hidden />
              <div id="ripple" className="ripple" />
              <div id="cursor" className="cursor">
                <svg viewBox="0 0 24 24" width="36" height="36"><path d="M4 2l16 10-7.2 1.6L9 21z" fill="#8FA8FF" stroke="#0B0E11" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                <span>Kris</span>
              </div>
            </div>
            <div className="chin"><span>KRIS</span><i className="power" /></div>
          </div>
          <div className="stand" /><div className="stand-foot" />
        </section>
        <aside className="seat"><Figure /></aside>
        <div className="desk" />
      </main>
    </div>
  );
}
