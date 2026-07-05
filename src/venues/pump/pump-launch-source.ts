import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Commitment, type Connection, type Finality, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { LaunchTimeoutError } from "../../core/errors.js";
import type { DiscoveredLaunch, LaunchFilter, LaunchSourcePlugin, WaitForLaunchArgs } from "../../launches/launch-source.js";
import { anchorDiscriminator } from "./anchor.js";
import { PUMP_PROGRAM_ID, WRAPPED_SOL_MINT } from "./constants.js";

const CREATE_D8 = anchorDiscriminator("create");
const CREATE_V2_D8 = anchorDiscriminator("create_v2");

class Cursor {
  private offset = 8;
  constructor(private readonly data: Buffer) {}
  string(): string {
    if (this.offset + 4 > this.data.length) throw new Error("Invalid Pump create data: missing string length");
    const length = this.data.readUInt32LE(this.offset); this.offset += 4;
    if (this.offset + length > this.data.length) throw new Error("Invalid Pump create data: truncated string");
    const value = this.data.subarray(this.offset, this.offset + length).toString("utf8"); this.offset += length;
    return value;
  }
  pubkey(): PublicKey {
    if (this.offset + 32 > this.data.length) throw new Error("Invalid Pump create data: missing creator");
    const key = new PublicKey(this.data.subarray(this.offset, this.offset + 32)); this.offset += 32;
    return key;
  }
}

function refValue(input?: string | PublicKey): string | undefined {
  return input instanceof PublicKey ? input.toBase58() : input;
}
function exactFilter(candidate: DiscoveredLaunch, filter: LaunchFilter): boolean {
  const expectedMint = refValue(filter.mint);
  const expectedCreator = refValue(filter.creator);
  const expectedQuote = refValue(filter.quoteMint);
  if (expectedMint && candidate.mint.toBase58() !== expectedMint) return false;
  if (filter.name && candidate.name !== filter.name) return false;
  if (filter.symbol && candidate.symbol?.toUpperCase() !== filter.symbol.replace(/^\$/, "").toUpperCase()) return false;
  if (expectedCreator && candidate.creator?.toBase58() !== expectedCreator) return false;
  if (expectedQuote && candidate.token.quoteMint !== expectedQuote) return false;
  return true;
}

function decodeCreateInstruction(args: {
  signature: string;
  slot: number | null;
  instruction: { programId: PublicKey; accounts: PublicKey[]; data: string };
}): DiscoveredLaunch | null {
  if (!args.instruction.programId.equals(PUMP_PROGRAM_ID)) return null;
  const data = Buffer.from(bs58.decode(args.instruction.data));
  const isV2 = data.subarray(0, 8).equals(CREATE_V2_D8);
  const isLegacy = data.subarray(0, 8).equals(CREATE_D8);
  if (!isV2 && !isLegacy) return null;
  const mint = args.instruction.accounts[0];
  if (!mint) return null;
  const cursor = new Cursor(data);
  const name = cursor.string();
  const symbol = cursor.string();
  cursor.string(); // uri, retained on-chain and unnecessary for routing
  const creator = cursor.pubkey();
  const quoteMint = isV2 && args.instruction.accounts[16]
    ? args.instruction.accounts[16]!
    : WRAPPED_SOL_MINT;
  const quoteProgram = isV2 && args.instruction.accounts[18]
    ? args.instruction.accounts[18]!
    : TOKEN_PROGRAM_ID;
  return {
    source: "pump-launch",
    signature: args.signature,
    slot: args.slot,
    mint,
    name,
    symbol,
    creator,
    token: {
      mint: mint.toBase58(),
      name,
      symbol,
      createKind: isV2 ? "create_v2" : "create",
      creator: creator.toBase58(),
      baseTokenProgram: (isV2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(),
      quoteMint: quoteMint.toBase58(),
      quoteTokenProgram: quoteProgram.toBase58(),
      venueHint: "pump-curve",
      metadataJson: JSON.stringify({ launchSignature: args.signature, launchSource: "pump-launch" }),
    },
    metadata: { instruction: isV2 ? "create_v2" : "create" },
  };
}

/** Watches the official Pump program and decodes create/create_v2 instructions locally. */
export class PumpLaunchSource implements LaunchSourcePlugin {
  readonly id = "pump-launch";

  private async candidate(connection: Connection, signature: string, commitment: Finality): Promise<DiscoveredLaunch | null> {
    const tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return null;
    for (const instruction of tx.transaction.message.instructions) {
      if (!("accounts" in instruction) || !("data" in instruction)) continue;
      const candidate = decodeCreateInstruction({
        signature,
        slot: tx.slot ?? null,
        instruction: instruction as { programId: PublicKey; accounts: PublicKey[]; data: string },
      });
      if (candidate) return candidate;
    }
    return null;
  }

  async waitForLaunch(connection: Connection, args: WaitForLaunchArgs): Promise<DiscoveredLaunch> {
    const watchCommitment: Commitment = args.commitment ?? "confirmed";
    const commitment: Finality = watchCommitment === "finalized" ? "finalized" : "confirmed";
    const timeoutMs = args.timeoutMs ?? 60_000;
    return await new Promise<DiscoveredLaunch>((resolve, reject) => {
      let settled = false;
      let subscriptionId: number | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = async () => {
        if (timeout) clearTimeout(timeout);
        args.signal?.removeEventListener("abort", aborted);
        if (subscriptionId != null) await connection.removeOnLogsListener(subscriptionId).catch(() => undefined);
      };
      const finish = (value: DiscoveredLaunch) => {
        if (settled) return;
        settled = true;
        void cleanup();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        void cleanup();
        reject(error);
      };
      const aborted = () => fail(new Error("Launch wait aborted"));
      if (args.signal?.aborted) { fail(new Error("Launch wait aborted")); return; }
      args.signal?.addEventListener("abort", aborted, { once: true });
      timeout = setTimeout(() => fail(new LaunchTimeoutError(this.id, timeoutMs)), timeoutMs);
      try {
        subscriptionId = connection.onLogs(PUMP_PROGRAM_ID, async (logInfo) => {
          if (settled || logInfo.err) return;
          try {
            const launch = await this.candidate(connection, logInfo.signature, commitment);
            if (launch && exactFilter(launch, args.filter)) finish(launch);
          } catch {
            // A malformed or temporarily unavailable transaction is not a matched launch.
          }
        }, watchCommitment);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
