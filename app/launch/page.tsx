import { ConsoleShell } from "../console-shell";

export default function Page() {
  return (
    <ConsoleShell
      page="launch"
      heading="Launch"
      description="Pump launch builder with per-wallet follower lanes, fee strategy, retries, and live/dry-run execution."
    />
  );
}
