import type { Connection } from "@solana/web3.js";
import type { PlannedTransaction, SimulationResult } from "../tx/types.ts";
import { measure } from "../core/log.ts";

const m = measure("simulate");
function tokenRaw(data: Buffer | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return data.readBigUInt64LE(64);
}
export async function simulatePlanned(
  connection: Connection,
  plan: PlannedTransaction,
): Promise<SimulationResult> {
  let result: SimulationResult | undefined;
  await m.measure("transaction", async () => {
    const addresses = plan.draft.trackedAccounts.map((a) =>
      a.address.toBase58(),
    );
    const before = addresses.length
      ? await connection.getMultipleAccountsInfo(
          plan.draft.trackedAccounts.map((a) => a.address),
          "confirmed",
        )
      : [];
    const simulation = await connection.simulateTransaction(plan.transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: addresses.length
        ? { encoding: "base64", addresses }
        : undefined,
    });
    const after = simulation.value.accounts ?? [];
    const accountChanges = addresses.map((address, index) => {
      const pre = before[index]?.lamports ?? null;
      const post = after[index]?.lamports ?? null;
      return {
        address,
        beforeLamports: pre,
        afterLamports: post,
        deltaLamports: pre == null || post == null ? null : post - pre,
      };
    });
    const tokenChanges = plan.draft.trackedAccounts
      .filter((a) => a.kind === "token")
      .map((tracked) => {
        const index = addresses.indexOf(tracked.address.toBase58());
        const preData = before[index]?.data as Buffer | undefined;
        const rawAfterData = after[index]?.data;
        const afterData =
          Array.isArray(rawAfterData) && rawAfterData[0]
            ? Buffer.from(rawAfterData[0], "base64")
            : undefined;
        const pre = tokenRaw(preData),
          post = tokenRaw(afterData);
        return {
          address: tracked.address.toBase58(),
          mint: tracked.mint?.toBase58() ?? null,
          beforeRaw: pre?.toString() ?? null,
          afterRaw: post?.toString() ?? null,
          deltaRaw:
            pre != null && post != null ? (post - pre).toString() : null,
        };
      });
    result = {
      success: simulation.value.err == null,
      logs: simulation.value.logs ?? [],
      cuUsed: simulation.value.unitsConsumed ?? null,
      error: simulation.value.err,
      accountChanges,
      tokenChanges,
      solChanges: accountChanges.filter(
        (row) =>
          plan.draft.trackedAccounts.find(
            (a) => a.address.toBase58() === row.address,
          )?.kind === "sol",
      ),
    };
    return {
      success: result.success,
      error: result.error,
      cuUsed: result.cuUsed,
      trackedAccounts: accountChanges.length,
      tokenChanges: tokenChanges.length,
      lastLogs: result.success ? [] : result.logs.slice(-4),
    };
  });
  if (!result) throw new Error("Simulation did not produce a result");
  return result;
}
