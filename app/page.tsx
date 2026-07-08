import { ConsoleShell } from "./console-shell";

export default function Page() {
  return (
    <ConsoleShell
      page="overview"
      heading="Home"
      description="High-level balances, connection status, recent launch/trade activity, and quick actions."
    />
  );
}
