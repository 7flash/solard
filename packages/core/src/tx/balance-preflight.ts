import {
  getAccountLenForMint,
  unpackMint,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  SystemInstruction,
  SystemProgram,
  type Connection,
  type PublicKey,
} from "@solana/web3.js";
import type { PlannedTransaction } from "./types.ts";
import { TradePreSubmissionError } from "./trade-errors.ts";

// Scope metadata to the connection/cluster. Refresh extensions periodically;
// account existence and wallet balances are never cached.
const caches = new WeakMap<
  Connection,
  {
    mints: Map<string, { length: number; expires: number }>;
    rent: Map<number, { value: Promise<number>; expires: number }>;
  }
>();
function cacheFor(connection: Connection) {
  let cache = caches.get(connection);
  if (!cache) {
    cache = { mints: new Map(), rent: new Map() };
    caches.set(connection, cache);
  }
  return cache;
}
export async function checkPlanBalance(
  connection: Connection,
  plan: PlannedTransaction,
): Promise<void> {
  const payer = plan.transaction.message.staticAccountKeys?.[0] ?? plan.payer;
  const cache = cacheFor(connection);
  const now = Date.now();
  let transfers = 0n;
  let rent = 0n;
  const atas = new Map<
    string,
    { address: PublicKey; mint: PublicKey; program: PublicKey }
  >();
  for (const instruction of plan.draft.instructions) {
    if (instruction.programId.equals(SystemProgram.programId)) {
      const kind = SystemInstruction.decodeInstructionType(instruction);
      if (kind === "Transfer") {
        const transfer = SystemInstruction.decodeTransfer(instruction);
        if (transfer.fromPubkey.equals(payer))
          transfers += BigInt(transfer.lamports);
      }
      if (kind === "Create") {
        const create = SystemInstruction.decodeCreateAccount(instruction);
        if (create.fromPubkey.equals(payer)) rent += BigInt(create.lamports);
      }
      if (kind === "CreateWithSeed") {
        const create = SystemInstruction.decodeCreateWithSeed(instruction);
        if (create.fromPubkey.equals(payer)) rent += BigInt(create.lamports);
      }
    }
    if (
      instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
      instruction.keys[0]?.pubkey.equals(payer)
    ) {
      const address = instruction.keys[1]!.pubkey;
      atas.set(address.toBase58(), {
        address,
        mint: instruction.keys[3]!.pubkey,
        program: instruction.keys[5]!.pubkey,
      });
    }
  }
  const requests = new Map<string, PublicKey>();
  for (const ata of atas.values()) {
    requests.set(ata.address.toBase58(), ata.address);
    const key = `${ata.mint.toBase58()}:${ata.program.toBase58()}`;
    if ((cache.mints.get(key)?.expires ?? 0) <= now)
      requests.set(ata.mint.toBase58(), ata.mint);
  }
  const addresses = [...requests.values()];
  const [balance, fee, accounts] = await Promise.all([
    connection.getBalance(payer, "confirmed"),
    connection.getFeeForMessage(plan.transaction.message, "confirmed"),
    addresses.length
      ? connection.getMultipleAccountsInfo(addresses, "confirmed")
      : Promise.resolve([]),
  ]);
  if (fee.value == null)
    throw new TradePreSubmissionError(
      Object.assign(new Error("Unable to estimate transaction fee"), {
        code: "FEE_UNAVAILABLE",
      }),
    );
  const fetched = new Map(
    addresses.map((address, index) => [address.toBase58(), accounts[index]]),
  );
  const missingLengths: number[] = [];
  for (const ata of atas.values()) {
    if (fetched.get(ata.address.toBase58())) continue;
    const key = `${ata.mint.toBase58()}:${ata.program.toBase58()}`;
    let metadata = cache.mints.get(key);
    if (!metadata || metadata.expires <= now) {
      if (
        !ata.program.equals(TOKEN_PROGRAM_ID) &&
        !ata.program.equals(TOKEN_2022_PROGRAM_ID)
      )
        throw new Error("Unsupported associated token mint program");
      const mint = unpackMint(
        ata.mint,
        fetched.get(ata.mint.toBase58()) ?? null,
        ata.program,
      );
      if (!mint.isInitialized)
        throw new Error("Uninitialized associated token mint");
      metadata = { length: getAccountLenForMint(mint), expires: now + 60_000 };
      cache.mints.set(key, metadata);
    }
    missingLengths.push(metadata.length);
  }
  const rents = await Promise.all(
    [...new Set(missingLengths)].map(async (length) => {
      let entry = cache.rent.get(length);
      if (!entry || entry.expires <= now) {
        const value = connection.getMinimumBalanceForRentExemption(
          length,
          "confirmed",
        );
        entry = { value, expires: now + 300_000 };
        cache.rent.set(length, entry);
        value.catch(() => {
          if (cache.rent.get(length)?.value === value)
            cache.rent.delete(length);
        });
      }
      return [length, await entry.value] as const;
    }),
  );
  const rentByLength = new Map(rents);
  for (const length of missingLengths)
    rent += BigInt(rentByLength.get(length)!);
  const buyPrincipal = plan.draft.actions
    .filter((action) => action.kind === "buy")
    .reduce(
      (total, action) => total + BigInt(String(action.meta?.inputRaw ?? 0)),
      0n,
    );
  const tip = plan.draft.actions
    .filter(
      (action) => action.kind === "helius-tip" || action.kind === "landing-tip",
    )
    .reduce(
      (total, action) =>
        total +
        BigInt(
          String(
            action.meta?.lamports ??
              action.meta?.tipLamports ??
              action.meta?.inputRaw ??
              0,
          ),
        ),
      0n,
    );
  const nonTipTransfers = transfers > tip ? transfers - tip : 0n;
  const principal =
    (nonTipTransfers > buyPrincipal ? nonTipTransfers : buyPrincipal) + tip;
  const required = principal + BigInt(fee.value) + rent;
  if (BigInt(balance) < required)
    throw new TradePreSubmissionError(
      Object.assign(
        new Error(
          `Insufficient SOL: need ${required} lamports including ${rent} account rent; available ${balance}`,
        ),
        {
          code: rent > 0n ? "INSUFFICIENT_SOL_FOR_RENT" : "INSUFFICIENT_SOL",
          requiredLamports: required,
          availableLamports: BigInt(balance),
        },
      ),
    );
}
