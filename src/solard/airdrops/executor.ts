import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import {
  createAirdropJob,
  getMutableAirdropJob,
  snapshotJob,
  updateAirdropJob,
} from "./job-store.js";
import { openAirdropRuntime } from "./runtime.js";
import type { AirdropJob, AirdropPlan } from "./types.js";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const globalState = globalThis as typeof globalThis & {
  __solardAirdropRunning?: Set<string>;
};
const running = (globalState.__solardAirdropRunning ??= new Set<string>());
const runtimes = new Map<
  string,
  Awaited<ReturnType<typeof openAirdropRuntime>>
>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function batchSize(): number {
  return Math.max(
    1,
    Math.min(10, Number(process.env.SOLARD_AIRDROP_BATCH_SIZE ?? "5") || 5),
  );
}

function chunks<T>(
  rows: T[],
  size: number,
): Array<{ start: number; rows: T[] }> {
  const output: Array<{ start: number; rows: T[] }> = [];
  for (let start = 0; start < rows.length; start += size) {
    output.push({ start, rows: rows.slice(start, start + size) });
  }
  return output;
}

function memoInstruction(message: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(message, "utf8"),
  });
}

async function signTransaction(
  transaction: Transaction,
  signer:
    | Signer
    | {
        publicKey: PublicKey;
        signTransaction(
          transaction: Transaction,
        ): Promise<Transaction> | Transaction;
      },
): Promise<Transaction> {
  if ("secretKey" in signer && signer.secretKey instanceof Uint8Array) {
    transaction.sign(signer);
    return transaction;
  }
  return await signer.signTransaction(transaction);
}

async function executeJob(id: string): Promise<void> {
  const job = getMutableAirdropJob(id);
  if (!job) return;

  const runtime =
    runtimes.get(id) ?? (await openAirdropRuntime(job.plan.bankWallet));
  runtimes.delete(id);
  try {
    await updateAirdropJob(id, (current) => {
      current.status = "running";
      current.startedAtMs = Date.now();
      current.logs.push({
        atMs: Date.now(),
        level: "info",
        message: "Server executor opened the managed bank wallet.",
      });
    });

    const { connection, signer } = runtime;
    const mint = new PublicKey(job.plan.payoutMint);
    const mintAccount = await connection.getAccountInfo(mint, "confirmed");
    if (!mintAccount) throw new Error("Payout mint account does not exist.");

    const tokenProgramId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : mintAccount.owner.equals(TOKEN_PROGRAM_ID)
        ? TOKEN_PROGRAM_ID
        : null;
    if (!tokenProgramId) {
      throw new Error(
        "Payout mint is not owned by the SPL Token or Token-2022 program.",
      );
    }

    const mintState = await getMint(
      connection,
      mint,
      "confirmed",
      tokenProgramId,
    );
    if (mintState.decimals !== job.plan.payoutDecimals) {
      throw new Error(
        `Payout mint has ${mintState.decimals} decimals, but the plan declares ${job.plan.payoutDecimals}.`,
      );
    }

    const bankAta = getAssociatedTokenAddressSync(
      mint,
      signer.publicKey,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const bankAccount = await getAccount(
      connection,
      bankAta,
      "confirmed",
      tokenProgramId,
    );
    const required = BigInt(job.plan.totalAmountRaw);
    if (bankAccount.amount < required) {
      throw new Error(
        `Bank token balance is ${bankAccount.amount.toString()} raw units; ${required.toString()} are required.`,
      );
    }

    const recipientBatches = chunks(job.recipients, batchSize());
    for (
      let batchIndex = 0;
      batchIndex < recipientBatches.length;
      batchIndex += 1
    ) {
      const batch = recipientBatches[batchIndex];
      await updateAirdropJob(id, (current) => {
        for (
          let index = batch.start;
          index < batch.start + batch.rows.length;
          index += 1
        ) {
          current.recipients[index].status = "sending";
        }
        current.logs.push({
          atMs: Date.now(),
          level: "info",
          message: `Building batch ${batchIndex + 1}/${recipientBatches.length} for ${batch.rows.length} recipients.`,
        });
      });

      try {
        const transaction = new Transaction();
        transaction.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        );

        for (const recipient of batch.rows) {
          const owner = new PublicKey(recipient.owner);
          const recipientAta = getAssociatedTokenAddressSync(
            mint,
            owner,
            true,
            tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          );
          transaction.add(
            createAssociatedTokenAccountIdempotentInstruction(
              signer.publicKey,
              recipientAta,
              owner,
              mint,
              tokenProgramId,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createTransferCheckedInstruction(
              bankAta,
              mint,
              recipientAta,
              signer.publicKey,
              BigInt(recipient.amountRaw),
              job.plan.payoutDecimals,
              [],
              tokenProgramId,
            ),
          );
        }

        transaction.add(
          memoInstruction(
            `${job.plan.memo ?? job.plan.name} | ${job.id} | batch ${batchIndex + 1}/${recipientBatches.length}`.slice(
              0,
              400,
            ),
          ),
        );

        const latest = await connection.getLatestBlockhash("confirmed");
        transaction.feePayer = signer.publicKey;
        transaction.recentBlockhash = latest.blockhash;
        const signed = await signTransaction(transaction, signer);
        const signature = await connection.sendRawTransaction(
          signed.serialize(),
          {
            skipPreflight: false,
            maxRetries: 3,
          },
        );
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (confirmation.value.err) {
          throw new Error(
            `Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`,
          );
        }

        await updateAirdropJob(id, (current) => {
          current.signatures.push(signature);
          for (
            let index = batch.start;
            index < batch.start + batch.rows.length;
            index += 1
          ) {
            current.recipients[index].status = "sent";
            current.recipients[index].signature = signature;
          }
          current.progress.attempted += batch.rows.length;
          current.progress.sent += batch.rows.length;
          current.progress.batchesComplete += 1;
          current.logs.push({
            atMs: Date.now(),
            level: "info",
            message: `Confirmed batch ${batchIndex + 1}: ${signature}`,
          });
        });
      } catch (error) {
        const message = errorText(error);
        await updateAirdropJob(id, (current) => {
          for (
            let index = batch.start;
            index < batch.start + batch.rows.length;
            index += 1
          ) {
            current.recipients[index].status = "failed";
            current.recipients[index].error = message;
          }
          current.progress.attempted += batch.rows.length;
          current.progress.failed += batch.rows.length;
          current.progress.batchesComplete += 1;
          current.logs.push({
            atMs: Date.now(),
            level: "error",
            message: `Batch ${batchIndex + 1} failed: ${message}`,
          });
        });
        throw error;
      }
    }

    await updateAirdropJob(id, (current) => {
      current.status = "completed";
      current.finishedAtMs = Date.now();
      current.logs.push({
        atMs: Date.now(),
        level: "info",
        message: `Airdrop completed: ${current.progress.sent}/${current.progress.total} recipients sent.`,
      });
    });
  } catch (error) {
    const message = errorText(error);
    await updateAirdropJob(id, (current) => {
      current.status = current.progress.sent > 0 ? "partial" : "failed";
      current.error = message;
      current.finishedAtMs = Date.now();
      current.logs.push({ atMs: Date.now(), level: "error", message });
    }).catch(() => undefined);
  } finally {
    runtime.close();
  }
}

function queue(id: string): void {
  if (running.has(id)) return;
  running.add(id);
  setTimeout(() => {
    void executeJob(id).finally(() => running.delete(id));
  }, 0);
}

export async function startAirdropJob(
  plan: AirdropPlan,
  serverRuntime?: unknown,
): Promise<AirdropJob> {
  const job = await createAirdropJob(plan);
  if (job.status === "queued") {
    try {
      const runtime = await openAirdropRuntime(plan.bankWallet, serverRuntime);
      runtimes.set(job.id, runtime);
      queue(job.id);
    } catch (error) {
      await updateAirdropJob(job.id, (current) => {
        current.status = "failed";
        current.error = errorText(error);
        current.finishedAtMs = Date.now();
        current.logs.push({
          atMs: Date.now(),
          level: "error",
          message: errorText(error),
        });
      });
      throw error;
    }
  }
  return snapshotJob(job);
}
