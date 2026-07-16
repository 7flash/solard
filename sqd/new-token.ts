// sqd.ts — Pump.fun create/create_v2 listener on SQD Portal.
//
// Fixes compared with the earlier version:
// - Uses the current Portal instruction filter key: `discriminator`.
//   (`d8` is still documented by some SQD pages, but current Portal query
//   clients normalize around `discriminator`.)
// - Applies finite --from/--to ranges to the data-source query itself.
// - Starts live mode slightly behind head so startup immediately catches recent
//   creates and reconnects idempotently.
// - Supports strict server-side filtering and a program-wide diagnostic mode.
// - Adds measure-fn spans plus a periodic heartbeat; silence is now observable.
// - Uses the official current Pump IDL layouts for create and create_v2.
//
// Install:
//   bun add @subsquid/solana-stream \
//           @subsquid/util-internal-data-source \
//           measure-fn
//
// Run:
//   bun run idxv2/sqd.ts
//   bun run idxv2/sqd.ts --from 433300000 --to 433310000
//   bun run idxv2/sqd.ts --probe
//   SQD_FILTER_MODE=program bun run idxv2/sqd.ts
//
// Environment:
//   PORTAL_URL             default: https://portal.sqd.dev/datasets/solana-mainnet
//   SQD_FILTER_MODE        strict | program, default strict
//   SQD_LIVE_LOOKBACK      slots behind head on live startup, default 500
//   SQD_PROBE_SLOTS        slots scanned by --probe, default 2000
//   SQD_HEARTBEAT_MS       status interval, default 10000
//   SQD_RETRY_MS           reconnect delay, default 3000
//   SQD_FINALIZED          1 = finalized stream, default hot stream
//   SQD_LOG_EVERY_BATCH    1 = measure every received batch
//
// Notes:
// - block.header.number is the Solana slot / Portal cursor.
// - block.header.height is optional Solana block height.
// - Hot streams can emit blocks that later fork out. Persist by event.id and
//   treat hot observations as provisional unless SQD_FINALIZED=1.

import {
  DataSourceBuilder,
  getInstructionData,
  getInstructionDescriptor,
} from "@subsquid/solana-stream";
import { isForkException } from "@subsquid/util-internal-data-source";
import { createMeasure } from "measure-fn";

const m = createMeasure("sqd");

// ---------------------------------------------------------------------------
// Pump ABI constants — @pump-fun/pump-sdk 1.36.0 / current public IDL
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// sha256("global:create")[0..8]
export const CREATE_D8 = "0x181ec828051c0777";

// sha256("global:create_v2")[0..8]
export const CREATE_V2_D8 = "0xd6904cec5f8b31b4";

const CREATE_DISC = Uint8Array.from([
  0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77,
]);

const CREATE_V2_DISC = Uint8Array.from([
  0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4,
]);

export type CreateInstructionKind = "create" | "create_v2";
export type FilterMode = "strict" | "program";

const CREATE_LAYOUT = {
  // create accounts:
  // 0 mint, 1 mint_authority, 2 bonding_curve, 3 associated_bonding_curve,
  // 4 global, 5 mpl_token_metadata, 6 metadata, 7 user, ...
  create: {
    mint: 0,
    bondingCurve: 2,
    user: 7,
    minAccounts: 14,
  },

  // create_v2 accounts:
  // 0 mint, 1 mint_authority, 2 bonding_curve, 3 associated_bonding_curve,
  // 4 global, 5 user, ...
  create_v2: {
    mint: 0,
    bondingCurve: 2,
    user: 5,
    minAccounts: 16,
  },
} as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORTAL_URL =
  process.env.PORTAL_URL ??
  "https://portal.sqd.dev/datasets/solana-mainnet";

const HEARTBEAT_MS = positiveIntEnv(
  "SQD_HEARTBEAT_MS",
  10_000,
);

const RETRY_MS = positiveIntEnv(
  "SQD_RETRY_MS",
  3_000,
);

const LIVE_LOOKBACK = nonNegativeIntEnv(
  "SQD_LIVE_LOOKBACK",
  500,
);

const PROBE_SLOTS = positiveIntEnv(
  "SQD_PROBE_SLOTS",
  2_000,
);

const USE_FINALIZED =
  process.env.SQD_FINALIZED === "1";

const LOG_EVERY_BATCH =
  process.env.SQD_LOG_EVERY_BATCH === "1";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function positiveIntEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function nonNegativeIntEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function parseNumberFlag(
  flag: string,
): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;

  const raw = process.argv[index + 1];
  const value = Number(raw);

  if (
    raw === undefined ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `${flag} requires a non-negative safe integer`,
    );
  }

  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

function timestampMs(
  value: number | undefined,
): number | null {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return null;
  }

  // @subsquid/solana-stream 1.x normalizes Portal seconds to ms. Keep a
  // seconds fallback so fixtures from older versions remain usable.
  return value < 100_000_000_000
    ? Math.trunc(value * 1_000)
    : Math.trunc(value);
}

function short(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

const B58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let leadingZeroes = 0;

  while (
    leadingZeroes < bytes.length &&
    bytes[leadingZeroes] === 0
  ) {
    leadingZeroes++;
  }

  const digits: number[] = [];

  for (let index = leadingZeroes; index < bytes.length; index++) {
    let carry = bytes[index]!;

    for (let digit = 0; digit < digits.length; digit++) {
      carry += digits[digit]! << 8;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let output = "1".repeat(leadingZeroes);

  for (let index = digits.length - 1; index >= 0; index--) {
    output += B58[digits[index]!]!;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Create instruction decoding
// ---------------------------------------------------------------------------

export interface CreateArgs {
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  isMayhemMode?: boolean;
  isCashbackEnabled?: boolean | null;
}

export function createInstructionKind(
  data: Uint8Array,
): CreateInstructionKind | null {
  if (data.length < 8) return null;

  const discriminator = data.subarray(0, 8);

  if (equalBytes(discriminator, CREATE_DISC)) {
    return "create";
  }

  if (equalBytes(discriminator, CREATE_V2_DISC)) {
    return "create_v2";
  }

  return null;
}

class BorshReader {
  #offset: number;
  readonly #view: DataView;

  constructor(
    readonly data: Uint8Array,
    offset = 0,
  ) {
    this.#offset = offset;
    this.#view = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  get remaining(): number {
    return this.data.length - this.#offset;
  }

  bytes(length: number): Uint8Array {
    if (length < 0 || this.remaining < length) {
      throw new Error(
        `borsh underrun: need=${length} remaining=${this.remaining}`,
      );
    }

    const result = this.data.subarray(
      this.#offset,
      this.#offset + length,
    );

    this.#offset += length;
    return result;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u32(): number {
    if (this.remaining < 4) {
      throw new Error("borsh underrun reading u32");
    }

    const value = this.#view.getUint32(
      this.#offset,
      true,
    );

    this.#offset += 4;
    return value;
  }

  string(): string {
    const length = this.u32();

    // Metadata strings should never be remotely close to this size. The cap
    // prevents corrupt data from requesting absurd slices.
    if (length > 1_000_000) {
      throw new Error(`unreasonable string length ${length}`);
    }

    return new TextDecoder().decode(
      this.bytes(length),
    );
  }

  pubkey(): string {
    return base58(this.bytes(32));
  }

  bool(): boolean {
    const value = this.u8();

    if (value !== 0 && value !== 1) {
      throw new Error(`invalid borsh bool ${value}`);
    }

    return value === 1;
  }

  optionBool(): boolean | null {
    const tag = this.u8();

    if (tag === 0) return null;
    if (tag !== 1) {
      throw new Error(`invalid OptionBool tag ${tag}`);
    }

    return this.bool();
  }
}

export function decodeCreateArgs(
  data: Uint8Array,
): CreateArgs | null {
  const kind = createInstructionKind(data);
  if (!kind) return null;

  try {
    const reader = new BorshReader(data, 8);

    const result: CreateArgs = {
      name: reader.string(),
      symbol: reader.string(),
      uri: reader.string(),
      creator: reader.pubkey(),
    };

    if (kind === "create_v2") {
      if (reader.remaining >= 1) {
        result.isMayhemMode = reader.bool();
      }

      if (reader.remaining >= 1) {
        result.isCashbackEnabled =
          reader.optionBool();
      }
    }

    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SQD data model
// ---------------------------------------------------------------------------

export interface NewTokenEvent {
  id: string;
  signature: string;
  instructionAddress: number[];
  instructionKind: CreateInstructionKind;
  slot: number;
  blockHeight?: number;
  timestampMs: number | null;
  detectedAt: number;
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  isMayhemMode?: boolean;
  isCashbackEnabled?: boolean | null;
  viaCpi: boolean;
}

export interface SqdBlockLike {
  header: {
    number: number;
    height?: number;
    timestamp?: number;
  };
  transactions: {
    transactionIndex: number;
    signatures?: string[];
    err?: null | object;
  }[];
  instructions: {
    transactionIndex: number;
    instructionAddress: number[];
    programId?: string;
    accounts?: string[];
    data?: string;
    isCommitted?: boolean;
  }[];
}

interface ExtractStats {
  instructions: number;
  creates: number;
  unknownDiscriminators: number;
  decodeFailures: number;
  accountLayoutFailures: number;
  missingTransactions: number;
  failedTransactions: number;
  missingSignatures: number;
}

interface ExtractResult {
  events: NewTokenEvent[];
  stats: ExtractStats;
  descriptors: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Source construction
// ---------------------------------------------------------------------------

interface SourceOptions {
  mode: FilterMode;
  from: number;
  to?: number;
}

export function buildSource(
  options: SourceOptions,
) {
  const where: Record<string, unknown> = {
    programId: [PUMP_PROGRAM],
    isCommitted: true,
  };

  if (options.mode === "strict") {
    // Current Portal-client query shape. Some older SQD docs call this d8.
    where.discriminator = [
      CREATE_D8,
      CREATE_V2_D8,
    ];
  }

  const range =
    options.to === undefined
      ? { from: options.from }
      : { from: options.from, to: options.to };

  return new DataSourceBuilder()
    .setPortal({
      url: PORTAL_URL,
      http: {
        retryAttempts: Infinity,
      },
    })
    .setFields({
      block: {
        timestamp: true,
        height: true,
      },
      transaction: {
        signatures: true,
        err: true,
      },
      instruction: {
        programId: true,
        accounts: true,
        data: true,
      },
    })
    .addInstruction({
      range,
      where: where as any,
      include: {
        transaction: true,
      },
    })
    .build();
}

// A tiny source is enough to fetch head metadata before the actual query range
// is known. It is never streamed.
function buildHeadSource() {
  return new DataSourceBuilder()
    .setPortal({
      url: PORTAL_URL,
      http: {
        retryAttempts: Infinity,
      },
    })
    .addInstruction({
      range: { from: 0 },
      where: {
        programId: [PUMP_PROGRAM],
      },
    })
    .build();
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractCreates(
  block: SqdBlockLike,
): ExtractResult {
  const stats: ExtractStats = {
    instructions: block.instructions.length,
    creates: 0,
    unknownDiscriminators: 0,
    decodeFailures: 0,
    accountLayoutFailures: 0,
    missingTransactions: 0,
    failedTransactions: 0,
    missingSignatures: 0,
  };

  const descriptors = new Map<string, number>();

  const txByIndex = new Map(
    block.transactions.map((transaction) => [
      transaction.transactionIndex,
      transaction,
    ]),
  );

  const events: NewTokenEvent[] = [];

  for (const instruction of block.instructions) {
    if (instruction.programId !== PUMP_PROGRAM) {
      continue;
    }

    if (!instruction.data || !instruction.accounts) {
      stats.decodeFailures++;
      continue;
    }

    let data: Uint8Array;

    try {
      data = getInstructionData(instruction as any);
    } catch {
      stats.decodeFailures++;
      continue;
    }

    const descriptor = getInstructionDescriptor(
      instruction as any,
    );

    descriptors.set(
      descriptor,
      (descriptors.get(descriptor) ?? 0) + 1,
    );

    const instructionKind =
      createInstructionKind(data);

    if (!instructionKind) {
      stats.unknownDiscriminators++;
      continue;
    }

    const layout =
      CREATE_LAYOUT[instructionKind];

    if (
      instruction.accounts.length <
      layout.minAccounts
    ) {
      stats.accountLayoutFailures++;
      continue;
    }

    const args = decodeCreateArgs(data);

    if (!args) {
      stats.decodeFailures++;
      continue;
    }

    const transaction = txByIndex.get(
      instruction.transactionIndex,
    );

    if (!transaction) {
      stats.missingTransactions++;
      continue;
    }

    if (transaction.err) {
      stats.failedTransactions++;
      continue;
    }

    const signature =
      transaction.signatures?.[0];

    if (!signature) {
      stats.missingSignatures++;
      continue;
    }

    const mint =
      instruction.accounts[layout.mint];
    const bondingCurve =
      instruction.accounts[layout.bondingCurve];
    const user =
      instruction.accounts[layout.user];

    if (!mint || !bondingCurve || !user) {
      stats.accountLayoutFailures++;
      continue;
    }

    const instructionAddress = [
      ...instruction.instructionAddress,
    ];

    events.push({
      id: `${signature}:${instructionAddress.join(".")}`,
      signature,
      instructionAddress,
      instructionKind,
      slot: block.header.number,
      blockHeight: block.header.height,
      timestampMs: timestampMs(
        block.header.timestamp,
      ),
      detectedAt: Date.now(),
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      mint,
      bondingCurve,
      user,
      creator: args.creator,
      isMayhemMode: args.isMayhemMode,
      isCashbackEnabled:
        args.isCashbackEnabled,
      viaCpi: instructionAddress.length > 1,
    });

    stats.creates++;
  }

  return {
    events,
    stats,
    descriptors,
  };
}

// ---------------------------------------------------------------------------
// Deduplication and runtime status
// ---------------------------------------------------------------------------

class LruSet {
  readonly #values = new Set<string>();

  constructor(
    readonly capacity: number,
  ) {}

  addIfNew(value: string): boolean {
    if (this.#values.has(value)) return false;

    this.#values.add(value);

    if (this.#values.size > this.capacity) {
      const oldest =
        this.#values.values().next().value;

      if (oldest !== undefined) {
        this.#values.delete(oldest);
      }
    }

    return true;
  }

  get size(): number {
    return this.#values.size;
  }
}

interface RuntimeStatus {
  startedAtMs: number;
  connectedAtMs: number;
  lastBatchAtMs: number;
  lastBlockAtMs: number;
  lastCreateAtMs: number;
  cursor: number;
  sourceHead: number;
  batches: number;
  blocks: number;
  instructions: number;
  creates: number;
  duplicates: number;
  decodeFailures: number;
  accountLayoutFailures: number;
  unknownDiscriminators: number;
  missingTransactions: number;
  failedTransactions: number;
  missingSignatures: number;
  reconnects: number;
  forks: number;
  descriptorCounts: Map<string, number>;
}

function createStatus(
  cursor: number,
  sourceHead: number,
): RuntimeStatus {
  return {
    startedAtMs: Date.now(),
    connectedAtMs: 0,
    lastBatchAtMs: 0,
    lastBlockAtMs: 0,
    lastCreateAtMs: 0,
    cursor,
    sourceHead,
    batches: 0,
    blocks: 0,
    instructions: 0,
    creates: 0,
    duplicates: 0,
    decodeFailures: 0,
    accountLayoutFailures: 0,
    unknownDiscriminators: 0,
    missingTransactions: 0,
    failedTransactions: 0,
    missingSignatures: 0,
    reconnects: 0,
    forks: 0,
    descriptorCounts: new Map(),
  };
}

function mergeDescriptors(
  target: Map<string, number>,
  source: Map<string, number>,
): void {
  for (const [descriptor, count] of source) {
    target.set(
      descriptor,
      (target.get(descriptor) ?? 0) + count,
    );
  }
}

function topDescriptors(
  values: Map<string, number>,
  limit = 8,
): Record<string, number> {
  return Object.fromEntries(
    [...values.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit),
  );
}

function ageMs(value: number): number | null {
  return value === 0
    ? null
    : Date.now() - value;
}

function startHeartbeat(
  status: RuntimeStatus,
  mode: FilterMode,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    m.sync(
      {
        start: () => "heartbeat",
        end: (value) => value,
        summarize: false,
        maxResultLength: 2_000,
      },
      () => ({
        mode,
        finalized: USE_FINALIZED,
        cursor: status.cursor,
        sourceHead: status.sourceHead,
        slotLag: Math.max(
          0,
          status.sourceHead - status.cursor,
        ),
        uptimeMs:
          Date.now() - status.startedAtMs,
        batches: status.batches,
        blocks: status.blocks,
        instructions: status.instructions,
        creates: status.creates,
        duplicates: status.duplicates,
        reconnects: status.reconnects,
        forks: status.forks,
        lastBatchAgeMs:
          ageMs(status.lastBatchAtMs),
        lastBlockAgeMs:
          ageMs(status.lastBlockAtMs),
        lastCreateAgeMs:
          ageMs(status.lastCreateAtMs),
        decodeFailures:
          status.decodeFailures,
        layoutFailures:
          status.accountLayoutFailures,
        unknownDiscriminators:
          status.unknownDiscriminators,
        missingTransactions:
          status.missingTransactions,
        failedTransactions:
          status.failedTransactions,
        missingSignatures:
          status.missingSignatures,
        topDiscriminators:
          topDescriptors(
            status.descriptorCounts,
          ),
      }),
    );
  }, HEARTBEAT_MS);

  (timer as any).unref?.();
  return timer;
}

// ---------------------------------------------------------------------------
// Event output
// ---------------------------------------------------------------------------

async function onToken(
  event: NewTokenEvent,
): Promise<void> {
  await m(
    {
      start: () =>
        `create:${event.instructionKind} ${short(event.mint)}`,
      end: () => ({
        id: event.id,
        mint: event.mint,
        bondingCurve: event.bondingCurve,
        creator: event.creator,
        slot: event.slot,
      }),
      summarize: false,
      maxResultLength: 1_500,
    },
    async () => {
      const lag =
        event.timestampMs === null
          ? "n/a"
          : `${event.detectedAt - event.timestampMs}ms`;

      console.log(
        `\n🚀 ${event.name} ($${event.symbol})` +
          ` [${event.instructionKind}]` +
          `${event.viaCpi ? " [via CPI]" : ""}\n` +
          `   mint       ${event.mint}\n` +
          `   curve      ${event.bondingCurve}\n` +
          `   user       ${event.user}\n` +
          `   creator    ${event.creator}\n` +
          `   mayhem     ${event.isMayhemMode ?? "n/a"}\n` +
          `   cashback   ${event.isCashbackEnabled ?? "n/a"}\n` +
          `   signature  ${event.signature}\n` +
          `   ix         ${event.instructionAddress.join(".")}\n` +
          `   height     ${event.blockHeight ?? "n/a"}\n` +
          `   slot       ${event.slot}  lag ${lag}\n` +
          `   uri        ${event.uri}`,
      );

      // Production seam:
      // await upsertCreateById(event);
      // priceVolumeTracker.admit(event.bondingCurve);
    },
  );
}

// ---------------------------------------------------------------------------
// Main stream loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await m.root(
    {
      start: () => "pump_listener",
      end: (result) => result,
      summarize: false,
      maxResultLength: 2_000,
    },
    async () => {
      const requestedMode =
        (
          process.env.SQD_FILTER_MODE ??
          "strict"
        ).toLowerCase();

      if (
        requestedMode !== "strict" &&
        requestedMode !== "program"
      ) {
        throw new Error(
          "SQD_FILTER_MODE must be strict or program",
        );
      }

      let mode =
        requestedMode as FilterMode;

      const probe = hasFlag("--probe");

      if (probe) {
        mode = "program";
      }

      const requestedFrom =
        parseNumberFlag("--from");
      const requestedTo =
        parseNumberFlag("--to");

      if (
        requestedTo !== undefined &&
        requestedFrom === undefined
      ) {
        throw new Error("--to requires --from");
      }

      if (
        requestedFrom !== undefined &&
        requestedTo !== undefined &&
        requestedTo < requestedFrom
      ) {
        throw new Error(
          "--to must be greater than or equal to --from",
        );
      }

      const headSource = buildHeadSource();

      const head = await m(
        {
          start: () => "get_head",
          end: (value) => ({
            number: value.number,
            hash: value.hash,
          }),
        },
        () => headSource.getHead(),
      );

      let from: number;
      let to = requestedTo;

      if (probe) {
        to = head.number;
        from = Math.max(
          0,
          head.number - PROBE_SLOTS,
        );
      } else if (requestedFrom !== undefined) {
        from = requestedFrom;
      } else {
        from = Math.max(
          0,
          head.number - LIVE_LOOKBACK,
        );
      }

      const finite = to !== undefined;

      m.sync(
        {
          start: () => "config",
          end: (value) => value,
          summarize: false,
          maxResultLength: 2_000,
        },
        () => ({
          portal: PORTAL_URL,
          program: PUMP_PROGRAM,
          mode,
          finalized: USE_FINALIZED,
          createDiscriminators: [
            CREATE_D8,
            CREATE_V2_D8,
          ],
          from,
          to: to ?? null,
          liveLookback: LIVE_LOOKBACK,
          probeSlots: probe
            ? PROBE_SLOTS
            : null,
          heartbeatMs: HEARTBEAT_MS,
          retryMs: RETRY_MS,
        }),
      );

      const source = buildSource({
        mode,
        from,
        to,
      });

      const status =
        createStatus(from, head.number);
      const dedupe = new LruSet(100_000);
      const heartbeat =
        startHeartbeat(status, mode);

      try {
        while (true) {
          status.connectedAtMs = Date.now();

          try {
            await m(
              {
                start: () =>
                  `stream:${mode} from=${status.cursor}` +
                  `${to === undefined ? "" : ` to=${to}`}`,
                end: () => ({
                  cursor: status.cursor,
                  creates: status.creates,
                  batches: status.batches,
                }),
                summarize: false,
              },
              async () => {
                const iterable = USE_FINALIZED
                  ? source.getFinalizedStream({
                      from: status.cursor,
                    })
                  : source.getStream({
                      from: status.cursor,
                    });

                for await (const batch of iterable) {
                  const processBatch = async () => {
                    status.lastBatchAtMs =
                      Date.now();
                    status.batches++;

                    for (const rawBlock of batch.blocks) {
                      const block =
                        rawBlock as SqdBlockLike;

                      status.blocks++;
                      status.lastBlockAtMs =
                        Date.now();

                      const result =
                        extractCreates(block);

                      status.instructions +=
                        result.stats.instructions;
                      status.decodeFailures +=
                        result.stats.decodeFailures;
                      status.accountLayoutFailures +=
                        result.stats.accountLayoutFailures;
                      status.unknownDiscriminators +=
                        result.stats.unknownDiscriminators;
                      status.missingTransactions +=
                        result.stats.missingTransactions;
                      status.failedTransactions +=
                        result.stats.failedTransactions;
                      status.missingSignatures +=
                        result.stats.missingSignatures;

                      mergeDescriptors(
                        status.descriptorCounts,
                        result.descriptors,
                      );

                      for (const event of result.events) {
                        if (!dedupe.addIfNew(event.id)) {
                          status.duplicates++;
                          continue;
                        }

                        await onToken(event);
                        status.creates++;
                        status.lastCreateAtMs =
                          Date.now();
                      }

                      // Advance only after all event side effects complete.
                      status.cursor =
                        block.header.number + 1;
                    }

                    return {
                      blocks: batch.blocks.length,
                      cursor: status.cursor,
                      totalCreates:
                        status.creates,
                    };
                  };

                  if (LOG_EVERY_BATCH) {
                    await m(
                      {
                        start: () =>
                          `batch blocks=${batch.blocks.length}`,
                        end: (value) => value,
                      },
                      processBatch,
                    );
                  } else {
                    await processBatch();
                  }
                }
              },
            );

            if (finite) {
              m.sync(
                {
                  start: () => "complete",
                  end: (value) => value,
                  summarize: false,
                },
                () => ({
                  from,
                  to,
                  mode,
                  blocks: status.blocks,
                  instructions:
                    status.instructions,
                  creates: status.creates,
                  topDiscriminators:
                    topDescriptors(
                      status.descriptorCounts,
                      20,
                    ),
                }),
              );

              break;
            }

            status.reconnects++;

            m.sync(
              "live_stream_ended",
              () => ({
                cursor: status.cursor,
                retryMs: RETRY_MS,
              }),
            );

            await sleep(RETRY_MS);
          } catch (error) {
            if (isForkException(error)) {
              status.forks++;

              const finalizedHead = await m(
                "get_finalized_head",
                () => source.getFinalizedHead(),
              );

              status.cursor = Math.min(
                status.cursor,
                finalizedHead.number,
              );

              m.sync(
                "fork_rewind",
                () => ({
                  cursor: status.cursor,
                  finalizedHead:
                    finalizedHead.number,
                }),
              );

              continue;
            }

            status.reconnects++;

            m.sync(
              "stream_retry",
              () => ({
                cursor: status.cursor,
                error:
                  errorMessage(error),
                retryMs: RETRY_MS,
              }),
            );

            await sleep(RETRY_MS);
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      return {
        mode,
        from,
        to: to ?? null,
        blocks: status.blocks,
        instructions: status.instructions,
        creates: status.creates,
        duplicates: status.duplicates,
        decodeFailures:
          status.decodeFailures,
        topDiscriminators:
          topDescriptors(
            status.descriptorCounts,
            20,
          ),
      };
    },
  );
}

if (import.meta.main) {
  process.on("SIGINT", () => {
    m.sync("stop:SIGINT", () => ({
      pid: process.pid,
    }));
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    m.sync("stop:SIGTERM", () => ({
      pid: process.pid,
    }));
    process.exit(0);
  });

  await main();
}
