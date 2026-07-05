export default function HomePage() {
  return (
    <div
      style={{
        maxWidth: "640px",
        margin: "80px auto",
        padding: "0 24px",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2.5rem", fontWeight: 700, marginBottom: "16px" }}>
        🦊 My App
      </h1>
      <p style={{ color: "#71717a", fontSize: "1.1rem", lineHeight: 1.6 }}>
        Your TradJS app is running. Edit <code>app/page.tsx</code> to get
        started.
      </p>
      <div id="app-root" style={{ marginTop: "32px" }} />
    </div>
  );
}
