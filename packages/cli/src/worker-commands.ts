import { listTelegramSignals, terminalStoreStats } from "@solard/core/db.ts";
import { formatProcessRow } from "@solard/core/solard/terminal/presenter.js";

export const workerCommands: Record<string, (args: string[]) => void> = {
  stats: () => {
    console.log("Terminal Stats:", terminalStoreStats());
  },
  signals: () => {
    console.log("Telegram Signals:", listTelegramSignals());
  },
  help: () => {
    console.log("Available commands: stats, signals, help");
  },
};
