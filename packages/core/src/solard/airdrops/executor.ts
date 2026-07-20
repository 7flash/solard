import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
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
  getAirdropJob,
  updateAirdropJob,
} from "./job-store.ts";
import { openAirdropRuntime, type ManagedAirdropSigner } from "./runtime.ts";
import type { AirdropJob, AirdropRecipientRun } from "./types.ts";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const globalState = globalThis as typeof globalThis & {
  __solardAirdropRunningV3?: Set<string>;
};
const running = (globalState.__solardAirdropRunningV3 ??= new Set<string>());

class ConfirmationUnknownError extends Error {
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
    this.name = "ConfirmationUnknownError";
  }
}

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
  signer: ManagedAirdropSigner,
): Promise<Transaction> {
  if ("secretKey" in signer && signer.secretKey instanceof Uint8Array) {
    transaction.sign(signer as Signer);
    return transaction;
  }
  const walletSigner = signer as {
    signTransaction?: (
      transaction: Transaction,
    ) => Promise<Transaction> | Transaction;
  };
  if (typeof walletSigner.signTransaction !== "function") {
    throw new Error("Managed wallet signer cannot sign a legacy transaction.");
  }
  return await walletSigner.signTransaction(transaction);
}

async function cancellationRequested(id: string): Promise<boolean> {
  return Boolean((await getAirdropJob(id))?.cancelRequested);
}

async function markCancelledRemainder(id: string): Promise<void> {
  await updateAirdropJob(id, (job) => {
    for (const recipient of job.recipients) {
      if (recipient.status === "queued" || recipient.status === "sending") {
        recipient.status = "cancelled";
        job.progress.cancelled += 1;
      }
    }
    job.status = "cancelled";
    job.finishedAtMs = Date.now();
    job.logs.push({
      atMs: Date.now(),
      level: "warn",
      message: `Airdrop cancelled after ${job.progress.sent} confirmed recipient transfers.`,
    });
  });
}

function tokenProgram(job: AirdropJob): PublicKey {
  return job.plan.payoutTokenProgram === "token-2022"
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

function buildTransaction(args: {
  job: AirdropJob;
  signer: ManagedAirdropSigner;
  bankAta: PublicKey;
  recipients: AirdropRecipientRun[];
  batchLabel: string;
}): Transaction {
  const mint = new PublicKey(args.job.plan.payoutMint);
  const programId = tokenProgram(args.job);
  const transaction = new Transaction();
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
  if (args.job.plan.priorityMicroLamports > 0) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: args.job.plan.priorityMicroLamports,
      }),
    );
  }

  for (const recipient of args.recipients) {
    const owner = new PublicKey(recipient.owner);
    const recipientAta = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        args.signer.publicKey,
        recipientAta,
        owner,
        mint,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        args.bankAta,
        mint,
        recipientAta,
        args.signer.publicKey,
        BigInt(recipient.amountRaw),
        args.job.plan.payoutDecimals,
        [],
        programId,
      ),
    );
  }

  transaction.add(
    memoInstruction(
      `${args.job.plan.memo ?? args.job.plan.name} | ${args.job.id} | ${args.batchLabel}`.slice(
        0,
        400,
      ),
    ),
  );
  return transaction;
}

async function submitAndConfirm(args: {
  id: string;
  connection: Connection;
  transaction: Transaction;
  signer: ManagedAirdropSigner;
  recipientIndexes: number[];
}): Promise<string> {
  const latest = await args.connection.getLatestBlockhash("confirmed");
  args.transaction.feePayer = args.signer.publicKey;
  args.transaction.recentBlockhash = latest.blockhash;
  const signed = await signTransaction(args.transaction, args.signer);
  const signature = await args.connection.sendRawTransaction(
    signed.serialize(),
    {
      skipPreflight: false,
      maxRetries: 3,
    },
  );

  await updateAirdropJob(args.id, (job) => {
    if (!job.signatures.includes(signature)) job.signatures.push(signature);
    for (const index of args.recipientIndexes) {
      job.recipients[index].status = "submitted";
      job.recipients[index].signature = signature;
    }
    job.logs.push({
      atMs: Date.now(),
      level: "info",
      message: `Submitted ${args.recipientIndexes.length} recipient transfer${args.recipientIndexes.length === 1 ? "" : "s"}: ${signature}`,
    });
  });

  let confirmation;
  try {
    confirmation = await args.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed",
    );
  } catch (error) {
    throw new ConfirmationUnknownError(
      `Transaction ${signature} was submitted but confirmation could not be established: ${errorText(error)}`,
      signature,
    );
  }
  if (confirmation.value.err) {
    throw Object.assign(
      new Error(
        `Transaction ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
      ),
      { signature, confirmedFailure: true },
    );
  }
  return signature;
}

async function sendRecipients(args: {
  id: string;
  job: AirdropJob;
  signer: ManagedAirdropSigner;
  connection: Connection;
  bankAta: PublicKey;
  recipientIndexes: number[];
  label: string;
}): Promise<string> {
  const recipients = args.recipientIndexes.map(
    (index) => args.job.recipients[index],
  );
  const transaction = buildTransaction({
    job: args.job,
    signer: args.signer,
    bankAta: args.bankAta,
    recipients,
    batchLabel: args.label,
  });
  return await submitAndConfirm({
    id: args.id,
    connection: args.connection,
    transaction,
    signer: args.signer,
    recipientIndexes: args.recipientIndexes,
  });
}

async function confirmRecipients(
  id: string,
  indexes: number[],
  signature: string,
): Promise<void> {
  await updateAirdropJob(id, (job) => {
    for (const index of indexes) {
      const recipient = job.recipients[index];
      recipient.status = "sent";
      recipient.signature = signature;
      recipient.error = undefined;
    }
    job.progress.attempted += indexes.length;
    job.progress.sent += indexes.length;
    job.logs.push({
      atMs: Date.now(),
      level: "info",
      message: `Confirmed ${indexes.length} recipient transfer${indexes.length === 1 ? "" : "s"}: ${signature}`,
    });
  });
}

async function failRecipients(
  id: string,
  indexes: number[],
  error: unknown,
): Promise<void> {
  const message = errorText(error);
  await updateAirdropJob(id, (job) => {
    for (const index of indexes) {
      const recipient = job.recipients[index];
      recipient.status = "failed";
      recipient.error = message;
    }
    job.progress.attempted += indexes.length;
    job.progress.failed += indexes.length;
    job.logs.push({ atMs: Date.now(), level: "error", message });
  });
}

async function executeJob(id: string): Promise<void> {
  const initial = await getAirdropJob(id);
  if (!initial || initial.status !== "queued") return;
  let runtime: Awaited<ReturnType<typeof openAirdropRuntime>>;
  try {
    runtime = await openAirdropRuntime(initial.plan.bankWallet);
  } catch (error) {
    const message = errorText(error);
    await updateAirdropJob(id, (job) => {
      job.status = "failed";
      job.error = message;
      job.finishedAtMs = Date.now();
      job.logs.push({ atMs: Date.now(), level: "error", message });
    });
    return;
  }

  try {
    await updateAirdropJob(id, (job) => {
      job.status = "running";
      job.startedAtMs = Date.now();
      job.logs.push({
        atMs: Date.now(),
        level: "info",
        message: "Server executor opened the managed bank wallet.",
      });
    });

    const job = (await getAirdropJob(id))!;
    const { connection, signer } = runtime;
    const mint = new PublicKey(job.plan.payoutMint);
    const programId = tokenProgram(job);
    const mintState = await getMint(connection, mint, "confirmed", programId);
    if (mintState.decimals !== job.plan.payoutDecimals) {
      throw new Error(
        `Payout mint decimals changed from preview ${job.plan.payoutDecimals} to ${mintState.decimals}.`,
      );
    }

    const bankAta = getAssociatedTokenAddressSync(
      mint,
      signer.publicKey,
      false,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const bankAccount = await getAccount(
      connection,
      bankAta,
      "confirmed",
      programId,
    );
    const required = BigInt(job.plan.totalAmountRaw);
    if (bankAccount.amount < required) {
      throw new Error(
        `Bank token balance is ${bankAccount.amount.toString()} raw units; ${required.toString()} are required.`,
      );
    }

    const solBalance = await connection.getBalance(
      signer.publicKey,
      "confirmed",
    );
    if (solBalance <= 0) {
      throw new Error(
        "The bank wallet has no SOL for transaction fees or recipient token-account rent.",
      );
    }

    const batches = chunks(job.recipients, batchSize());
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (await cancellationRequested(id)) {
        await markCancelledRemainder(id);
        return;
      }

      const batch = batches[batchIndex];
      const indexes = batch.rows.map(
        (_recipient, offset) => batch.start + offset,
      );
      await updateAirdropJob(id, (current) => {
        for (const index of indexes)
          current.recipients[index].status = "sending";
        current.logs.push({
          atMs: Date.now(),
          level: "info",
          message: `Building batch ${batchIndex + 1}/${batches.length} for ${indexes.length} recipients.`,
        });
      });

      try {
        const current = (await getAirdropJob(id))!;
        const signature = await sendRecipients({
          id,
          job: current,
          signer,
          connection,
          bankAta,
          recipientIndexes: indexes,
          label: `batch ${batchIndex + 1}/${batches.length}`,
        });
        await confirmRecipients(id, indexes, signature);
      } catch (error) {
        if (error instanceof ConfirmationUnknownError) {
          await updateAirdropJob(id, (current) => {
            current.status = "attention";
            current.error = error.message;
            current.finishedAtMs = Date.now();
            current.logs.push({
              atMs: Date.now(),
              level: "error",
              message:
                "Execution stopped to avoid duplicate transfers. Verify the submitted signature on-chain before retrying.",
            });
          });
          return;
        }

        await updateAirdropJob(id, (current) => {
          for (const index of indexes) {
            current.recipients[index].status = "queued";
            current.recipients[index].signature = undefined;
            current.recipients[index].error = undefined;
          }
          current.logs.push({
            atMs: Date.now(),
            level: "warn",
            message: `Batch ${batchIndex + 1} failed before a confirmed transfer. Falling back to one recipient per transaction: ${errorText(error)}`,
          });
        });

        for (const index of indexes) {
          if (await cancellationRequested(id)) {
            await markCancelledRemainder(id);
            return;
          }
          await updateAirdropJob(id, (current) => {
            current.recipients[index].status = "sending";
          });
          try {
            const current = (await getAirdropJob(id))!;
            const signature = await sendRecipients({
              id,
              job: current,
              signer,
              connection,
              bankAta,
              recipientIndexes: [index],
              label: `recipient ${index + 1}/${current.progress.total}`,
            });
            await confirmRecipients(id, [index], signature);
          } catch (singleError) {
            if (singleError instanceof ConfirmationUnknownError) {
              await updateAirdropJob(id, (current) => {
                current.status = "attention";
                current.error = singleError.message;
                current.finishedAtMs = Date.now();
                current.logs.push({
                  atMs: Date.now(),
                  level: "error",
                  message:
                    "Execution stopped to avoid a duplicate retry. Verify the submitted signature on-chain.",
                });
              });
              return;
            }
            await failRecipients(id, [index], singleError);
          }
        }
      } finally {
        await updateAirdropJob(id, (current) => {
          current.progress.batchesComplete += 1;
        });
      }
    }

    await updateAirdropJob(id, (job) => {
      job.finishedAtMs = Date.now();
      job.status =
        job.progress.failed > 0
          ? job.progress.sent > 0
            ? "partial"
            : "failed"
          : "completed";
      job.logs.push({
        atMs: Date.now(),
        level: job.status === "completed" ? "info" : "warn",
        message: `Airdrop ${job.status}: ${job.progress.sent}/${job.progress.total} recipients confirmed.`,
      });
    });
  } catch (error) {
    const message = errorText(error);
    await updateAirdropJob(id, (job) => {
      if (job.status === "attention" || job.status === "cancelled") return;
      job.status = job.progress.sent > 0 ? "partial" : "failed";
      job.error = message;
      job.finishedAtMs = Date.now();
      job.logs.push({ atMs: Date.now(), level: "error", message });
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
  plan: AirdropJob["plan"],
): Promise<AirdropJob> {
  const job = await createAirdropJob(plan);
  if (job.status === "queued") queue(job.id);
  return job;
}
