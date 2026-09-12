import bs58 from "bs58";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import type { Solard } from "../core/solard.ts";
import type {
  PlannedTransaction,
  SendReceipt,
  SimulationResult,
  SubmittedPlan,
} from "../tx/types.ts";

const UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const BUFFER_STATE_TAG = Buffer.from([1, 0, 0, 0]);
const OPTION_SOME_TAG = Buffer.from([1]);
const CLOSE_INSTRUCTION = Buffer.from([5, 0, 0, 0]);

export type RegistryProgramBuffer = {
  walletName: string;
  authority: string;
  buffer: string;
  lamports: bigint;
  dataLength: number;
};

export type RegistryProgramBufferPlan = {
  walletsScanned: number;
  buffers: RegistryProgramBuffer[];
  reclaimableLamports: bigint;
  scanErrors: Array<{ walletName: string; authority: string; error: string }>;
};

export type RegistryProgramBufferResult = {
  buffer: RegistryProgramBuffer;
  simulation?: SimulationResult;
  receipt?: SendReceipt;
  verified?: boolean;
  error?: string;
};

export type RegistryProgramBufferOptions = {
  walletRefs?: string[];
  delayMs?: number;
};

const pause = (ms: number) =>
  ms > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

function selectedWallets(slrd: Solard, refs?: string[]) {
  const all = slrd.wallets.list();
  if (!refs?.length) return all;
  const addresses = new Set(
    refs.map((ref) => slrd.resolveWallet(ref).address.toBase58()),
  );
  return all.filter((wallet) => addresses.has(wallet.address));
}

function isExpectedBufferData(data: Buffer, authority: PublicKey): boolean {
  if (data.length < 37) return false;
  if (data.readUInt32LE(0) !== 1 || data[4] !== 1) return false;
  return new PublicKey(data.subarray(5, 37)).equals(authority);
}

export async function planRegistryProgramBuffers(
  slrd: Solard,
  options: RegistryProgramBufferOptions = {},
): Promise<RegistryProgramBufferPlan> {
  const wallets = selectedWallets(slrd, options.walletRefs);
  const buffers: RegistryProgramBuffer[] = [];
  const scanErrors: RegistryProgramBufferPlan["scanErrors"] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);

  for (const wallet of wallets) {
    const authority = new PublicKey(wallet.address);
    try {
      const rows = await slrd
        .connection()
        .getProgramAccounts(UPGRADEABLE_LOADER, {
          commitment: "confirmed",
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(BUFFER_STATE_TAG) } },
            { memcmp: { offset: 4, bytes: bs58.encode(OPTION_SOME_TAG) } },
            { memcmp: { offset: 5, bytes: authority.toBase58() } },
          ],
        });
      for (const row of rows) {
        const data = Buffer.from(row.account.data);
        if (!isExpectedBufferData(data, authority)) continue;
        buffers.push({
          walletName: wallet.name,
          authority: wallet.address,
          buffer: row.pubkey.toBase58(),
          lamports: BigInt(row.account.lamports),
          dataLength: data.length,
        });
      }
    } catch (error) {
      scanErrors.push({
        walletName: wallet.name,
        authority: wallet.address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await pause(delayMs);
  }

  buffers.sort((a, b) =>
    a.lamports === b.lamports
      ? a.buffer.localeCompare(b.buffer)
      : a.lamports > b.lamports
        ? -1
        : 1,
  );
  return {
    walletsScanned: wallets.length,
    buffers,
    reclaimableLamports: buffers.reduce((sum, row) => sum + row.lamports, 0n),
    scanErrors,
  };
}

function closeBufferInstruction(
  row: RegistryProgramBuffer,
): TransactionInstruction {
  const buffer = new PublicKey(row.buffer);
  const authority = new PublicKey(row.authority);
  return new TransactionInstruction({
    programId: UPGRADEABLE_LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      // Reclaim to the authority wallet first. The later SOL sweep is a normal
      // SystemProgram transfer to the exchange destination.
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: CLOSE_INSTRUCTION,
  });
}

async function buildClosePlan(slrd: Solard, row: RegistryProgramBuffer) {
  return await slrd
    .tx(row.authority)
    .add(closeBufferInstruction(row), {
      kind: "close-program-buffer",
    })
    .build();
}

async function settleSubmittedPlan(
  slrd: Solard,
  submission: SubmittedPlan,
  plan: PlannedTransaction,
): Promise<SendReceipt> {
  const connection = slrd.connection();
  let lastHeightCheckAt = 0;
  let currentHeight = -1;
  let processedAfterExpiryAt = 0;
  for (;;) {
    const status = (
      await connection.getSignatureStatuses([submission.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (
      status?.err ||
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      const receipt = await slrd.confirmSubmission(submission, 5_000);
      if (receipt.status !== "confirmed") {
        throw new Error(
          `Program-buffer close ${submission.signature} ended with status=${receipt.status}${receipt.error ? `: ${receipt.error}` : ""}.`,
        );
      }
      return receipt;
    }
    const now = Date.now();
    if (now - lastHeightCheckAt >= 2_000) {
      currentHeight = await connection.getBlockHeight("confirmed");
      lastHeightCheckAt = now;
    }
    if (currentHeight > plan.lastValidBlockHeight) {
      if (status?.confirmationStatus === "processed") {
        if (processedAfterExpiryAt === 0) processedAfterExpiryAt = now;
        if (now - processedAfterExpiryAt < 15_000) {
          await pause(500);
          continue;
        }
        throw new Error(
          `Program-buffer close ${submission.signature} remained only processed after blockhash expiry; close is unresolved.`,
        );
      }
      throw new Error(
        `Program-buffer close ${submission.signature} expired before confirmation.`,
      );
    }
    await pause(500);
  }
}

async function sendStrictClose(
  slrd: Solard,
  row: RegistryProgramBuffer,
): Promise<SendReceipt> {
  const plan = await buildClosePlan(slrd, row);
  const submission = await slrd.submitPlan(
    plan,
    "rpc",
    "registry-program-buffer-close",
    { skipSimulation: false, skipPreflight: false },
  );
  return await settleSubmittedPlan(slrd, submission, plan);
}

export async function simulateRegistryProgramBuffers(
  slrd: Solard,
  plan: RegistryProgramBufferPlan,
  options: RegistryProgramBufferOptions = {},
): Promise<RegistryProgramBufferResult[]> {
  const out: RegistryProgramBufferResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);
  for (const buffer of plan.buffers) {
    try {
      out.push({
        buffer,
        simulation: await slrd.simulatePlan(await buildClosePlan(slrd, buffer)),
      });
    } catch (error) {
      out.push({
        buffer,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await pause(delayMs);
  }
  return out;
}

export async function executeRegistryProgramBuffers(
  slrd: Solard,
  plan: RegistryProgramBufferPlan,
  options: RegistryProgramBufferOptions = {},
): Promise<RegistryProgramBufferResult[]> {
  if (plan.scanErrors.length) {
    throw new Error(
      `Refusing program-buffer cleanup because ${plan.scanErrors.length} authority scan(s) failed.`,
    );
  }
  const out: RegistryProgramBufferResult[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 100);
  for (const buffer of plan.buffers) {
    try {
      const info = await slrd
        .connection()
        .getAccountInfo(new PublicKey(buffer.buffer), "confirmed");
      if (!info) {
        out.push({ buffer, verified: true });
      } else {
        if (!info.owner.equals(UPGRADEABLE_LOADER)) {
          throw new Error(
            `Buffer ${buffer.buffer} is no longer owned by the upgradeable loader.`,
          );
        }
        if (
          !isExpectedBufferData(
            Buffer.from(info.data),
            new PublicKey(buffer.authority),
          )
        ) {
          throw new Error(
            `Buffer ${buffer.buffer} no longer matches authority ${buffer.authority}.`,
          );
        }
        const receipt = await sendStrictClose(slrd, buffer);
        let remaining = await slrd
          .connection()
          .getAccountInfo(new PublicKey(buffer.buffer), "confirmed");
        for (let attempt = 0; remaining && attempt < 4; attempt += 1) {
          await pause(350);
          remaining = await slrd
            .connection()
            .getAccountInfo(new PublicKey(buffer.buffer), "confirmed");
        }
        if (remaining)
          throw new Error(
            `Buffer ${buffer.buffer} close confirmed but account still exists.`,
          );
        out.push({ buffer, receipt, verified: true });
      }
    } catch (error) {
      out.push({
        buffer,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await pause(delayMs);
  }
  return out;
}
