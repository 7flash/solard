import { ConsoleShell } from "../console-shell";

export default function Page() {
  return (
    <ConsoleShell
      page="trade"
      heading="Trade"
      description="Manual buys and sells through the shared Solard SDK transaction engine."
    />
  );
}
