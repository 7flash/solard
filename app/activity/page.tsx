import { ConsoleShell } from "../console-shell";

export default function Page() {
  return (
    <ConsoleShell
      page="jobs"
      heading="Activity"
      description="High-level launch jobs, trade executions, retry lanes, and structured run logs."
    />
  );
}
