import { runLaunchWatchCommand } from "./launch-watch-command.ts";

type Flags = Map<string, string>;
type Emit = (value: string) => void;

export async function runPumpWatchCommand(args: {
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  await runLaunchWatchCommand({ ...args, forcedVenues: ["pump"] });
}
