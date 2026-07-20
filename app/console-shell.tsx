import { PageHost, type ConsolePage } from "./page-host.tsx";

/**
 * Deprecated compatibility shim.
 * New routes should import PageHost directly so app/layout.tsx is the only
 * server-side shell and the client runtime owns page headers.
 */
export function ConsoleShell(args: {
  page: ConsolePage;
  heading?: string;
  description?: string;
  eyebrow?: string;
}) {
  return <PageHost page={args.page} />;
}
