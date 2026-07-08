type RootLayoutProps = { children: unknown };

type NavItem = { href: string; label: string; page: string };

const NAV: NavItem[] = [
  { href: "/", label: "Home", page: "overview" },
  { href: "/terminal", label: "Pump terminal", page: "terminal" },
  { href: "/watchlists", label: "Watchlists", page: "watchlists" },
  { href: "/signals", label: "Signals", page: "signals" },
  { href: "/launch", label: "Launch", page: "launch" },
  { href: "/wallets", label: "Wallets", page: "wallets" },
  { href: "/portfolio", label: "Portfolio", page: "portfolio" },
  { href: "/trade", label: "Trade", page: "trade" },
  { href: "/activity", label: "Activity", page: "jobs" },
];

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Solard Console</title>
        <link rel="stylesheet" href="/globals.css" />
      </head>
      <body>
        <main className="shell page-shell">
          <aside className="side-nav">
            <div className="brand-block">
              <p className="eyebrow">SOLARD</p>
              <h1>Console</h1>
            </div>
            <nav className="nav-list" id="main-nav">
              {NAV.map((item) => (
                <a key={item.page} data-page={item.page} href={item.href}>
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

          <section className="main-console">{children}</section>
        </main>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(()=>{const p=location.pathname.replace(/\\/+$/,'');const page=p.endsWith('/wallets')?'wallets':p.endsWith('/portfolio')?'portfolio':p.endsWith('/terminal')?'terminal':p.endsWith('/watchlists')?'watchlists':p.endsWith('/signals')?'signals':p.endsWith('/launch')?'launch':p.endsWith('/trade')?'trade':p.endsWith('/activity')?'jobs':'overview';document.querySelectorAll('#main-nav a').forEach(a=>{const active=a.dataset.page===page;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});})();",
          }}
        />
      </body>
    </html>
  );
}
