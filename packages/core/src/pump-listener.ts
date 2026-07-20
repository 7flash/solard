// sqd.ts — Pump.fun create/create_v2 listener using SQD Portal directly.
//
// No @subsquid packages are imported. The only external dependency is
// `measure-fn` for structured timing and heartbeat logs.
//
// Install:
//   bun add measure-fn
//
// Run:
//   bun run idxv2/sqd.ts
//   bun run idxv2/sqd.ts --from 433300000 --to 433310000
//   bun run idxv2/sqd.ts --probe
//
// Environment:
//   PORTAL_URL=https://portal.sqd.dev/datasets/solana-mainnet
//   SQD_FINALIZED=1                 use /finalized-stream
//   SQD_FILTER_MODE=strict|program  default strict
//   SQD_LIVE_LOOKBACK=2000          slots replayed before following head
//   SQD_PROBE_SLOTS=500             program-wide slots scanned by --probe
//   SQD_HEARTBEAT_MS=10000
//   SQD_POLL_MS=1000
//   SQD_RETRY_MS=3000
//   SQD_REQUEST_TIMEOUT_MS=60000
//   SQD_DEDUPE_SIZE=100000
//   SQD_REORG_REWIND=128
//   SQD_LOG_QUERY=1                 print the exact Portal body at startup
//
// Portal facts used by this client:
// - POST /stream or /finalized-stream returns newline-delimited JSON.
// - A single response is only one batch; reconnect from last header.number + 1.
// - 204 means no data is currently available for the requested range.
// - Instruction relation `transaction: true` includes parent transactions.
// - `block.header.number` is the Solana slot / Portal cursor.
// - Hot /stream may return 409 when parentBlockHash no longer matches.
//
// Hot-mode warning:
// An event emitted from an unfinalized block can later be orphaned. This file
// rewinds and deduplicates canonical replay, but it cannot reverse arbitrary
// external side effects already performed by onToken. Use SQD_FINALIZED=1 for
// append-only authoritative ingestion, or persist provisional/finalized state.

import { configure, createMeasure } from "measure-fn";

configure({
  summarize: true,
  maxResultLength: 4_000,
  sensitiveKeyPattern:
    /secret|private|mnemonic|seed|keypair|password|authorization|cookie|token|apikey|api_key/i,
});

const m = createMeasure("sqd-fetch");

// ---------------------------------------------------------------------------
// Pump ABI constants
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

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
  // Legacy create:
  // 0 mint, 1 mint_authority, 2 bonding_curve, 3 associated_bonding_curve,
  // 4 global, 5 mpl_token_metadata, 6 metadata, 7 user, ...
  create: {
    mint: 0,
    bondingCurve: 2,
    user: 7,
    minAccounts: 14,
  },

  // Current create_v2:
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

const PORTAL_URL = (
  process.env.PORTAL_URL ?? "https://portal.sqd.dev/datasets/solana-mainnet"
).replace(/\/+$/, "");

const USE_FINALIZED = process.env.SQD_FINALIZED === "1";

const FILTER_MODE = enumEnv<FilterMode>(
  "SQD_FILTER_MODE",
  ["strict", "program"],
  "strict",
);

const LIVE_LOOKBACK = nonNegativeIntEnv("SQD_LIVE_LOOKBACK", 2_000);

const PROBE_SLOTS = positiveIntEnv("SQD_PROBE_SLOTS", 500);

const HEARTBEAT_MS = positiveIntEnv("SQD_HEARTBEAT_MS", 10_000);

const POLL_MS = positiveIntEnv("SQD_POLL_MS", 1_000);

const RETRY_MS = positiveIntEnv("SQD_RETRY_MS", 3_000);

const REQUEST_TIMEOUT_MS = positiveIntEnv("SQD_REQUEST_TIMEOUT_MS", 60_000);

const DEDUPE_SIZE = positiveIntEnv("SQD_DEDUPE_SIZE", 100_000);

const REORG_REWIND = positiveIntEnv("SQD_REORG_REWIND", 128);

const LOG_QUERY = process.env.SQD_LOG_QUERY === "1";

// ---------------------------------------------------------------------------
// Portal request / response models
// ---------------------------------------------------------------------------

interface PortalHead {
  number: number;
  hash: string;
}

interface PortalTransaction {
  transactionIndex: number;
  signatures?: string[];
  err?: null | object;
}

interface PortalInstruction {
  transactionIndex: number;
  instructionAddress: number[];
  programId?: string;
  accounts?: string[];
  data?: string;
  isCommitted?: boolean;
}

export interface PortalBlock {
  header: {
    number: number;
    hash: string;
    parentNumber?: number;
    parentHash?: string;
    height?: number;
    timestamp?: number;
  };
  transactions?: PortalTransaction[];
  instructions?: PortalInstruction[];
}

interface PortalInstructionFilter {
  programId: string[];
  d8?: string[];
  isCommitted?: boolean;

  // Portal relation flag: include the transaction containing each match.
  transaction: true;
}

interface PortalQuery {
  type: "solana";
  fromBlock: number;
  toBlock?: number;
  parentBlockHash?: string;
  fields: {
    block: {
      number: true;
      hash: true;
      parentNumber: true;
      parentHash: true;
      height: true;
      timestamp: true;
    };
    transaction: {
      transactionIndex: true;
      signatures: true;
      err: true;
    };
    instruction: {
      transactionIndex: true;
      instructionAddress: true;
      programId: true;
      accounts: true;
      data: true;
      isCommitted: true;
    };
  };
  instructions: PortalInstructionFilter[];
}

interface PortalHeaders {
  headNumber?: number;
  finalizedHeadNumber?: number;
  finalizedHeadHash?: string;
  dataSource?: string;
}

interface PortalBatchSummary {
  httpStatus: number;
  blocks: number;
  bytes: number;
  firstSlot?: number;
  lastSlot?: number;
  headNumber?: number;
  finalizedHeadNumber?: number;
  dataSource?: string;
}

interface PortalConflictBody {
  previousBlocks?: {
    number: number;
    hash: string;
  }[];
}

// ---------------------------------------------------------------------------
// Output model
// ---------------------------------------------------------------------------

export interface CreateArgs {
  name: string;
  symbol: string;
  uri: string;
  creator?: string;
  isMayhemMode?: boolean;
  isCashbackEnabled?: boolean | null;
}

export interface NewTokenEvent {
  /** Durable idempotency key; signature alone is not instruction-unique. */
  id: string;
  signature: string;
  instructionAddress: number[];
  instructionKind: CreateInstructionKind;

  /** SQD Portal cursor and Solana slot. */
  slot: number;

  blockHeight?: number;
  blockHash: string;
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

// ---------------------------------------------------------------------------
// Environment and argument helpers
// ---------------------------------------------------------------------------

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function enumEnv<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }

  return raw as T;
}

function parseNumberFlag(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);

  if (index < 0) return undefined;

  const raw = process.argv[index + 1];
  const value = Number(raw);

  if (raw === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${flag} requires a non-negative safe integer`);
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
  return error instanceof Error ? error.message : String(error);
}

function short(value: string): string {
  if (value.length <= 16) return value;

  return `${value.slice(0, 8)}…` + value.slice(-6);
}

function timestampToMs(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  // Portal currently returns Unix seconds. Keep milliseconds compatible.
  return value >= 100_000_000_000
    ? Math.trunc(value)
    : Math.trunc(value * 1_000);
}

function parseOptionalInteger(value: string | null): number | undefined {
  if (!value) return undefined;

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function retryAfterMs(response: Response, fallback: number): number {
  const raw = response.headers.get("retry-after");

  if (!raw) return fallback;

  const seconds = Number(raw);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(100, Math.trunc(seconds * 1_000));
  }

  const dateMs = Date.parse(raw);

  return Number.isFinite(dateMs)
    ? Math.max(100, dateMs - Date.now())
    : fallback;
}

// ---------------------------------------------------------------------------
// Base58 / Borsh decoding
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const B58_INDEX = new Map<string, number>(
  [...B58].map((character, index) => [character, index]),
);

export function base58Decode(value: string): Uint8Array {
  if (value.length === 0) {
    return new Uint8Array();
  }

  let leadingOnes = 0;

  while (leadingOnes < value.length && value[leadingOnes] === "1") {
    leadingOnes++;
  }

  // Little-endian base-256 digits.
  const bytes: number[] = [];

  for (let index = leadingOnes; index < value.length; index++) {
    const digit = B58_INDEX.get(value[index]!);

    if (digit === undefined) {
      throw new Error(`invalid base58 character at ${index}`);
    }

    let carry = digit;

    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
      carry += bytes[byteIndex]! * 58;
      bytes[byteIndex] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const output = new Uint8Array(leadingOnes + bytes.length);

  for (let index = 0; index < leadingOnes; index++) {
    output[index] = 0;
  }

  for (let index = 0; index < bytes.length; index++) {
    output[output.length - 1 - index] = bytes[index]!;
  }

  return output;
}

function base58Encode(bytes: Uint8Array): string {
  let leadingZeroes = 0;

  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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

    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
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

    const result = this.data.subarray(this.#offset, this.#offset + length);

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

    const value = this.#view.getUint32(this.#offset, true);

    this.#offset += 4;

    return value;
  }

  string(): string {
    const length = this.u32();

    if (length > 1_000_000) {
      throw new Error(`unreasonable string length ${length}`);
    }

    return new TextDecoder().decode(this.bytes(length));
  }

  pubkey(): string {
    return base58Encode(this.bytes(32));
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

export function decodeCreateArgs(data: Uint8Array): CreateArgs | null {
  const kind = createInstructionKind(data);

  if (!kind) return null;

  try {
    const reader = new BorshReader(data, 8);

    const result: CreateArgs = {
      name: reader.string(),
      symbol: reader.string(),
      uri: reader.string(),
    };

    // Current create and create_v2 both carry creator after the strings.
    // Keep this optional for replay compatibility with older layouts.
    if (reader.remaining >= 32) {
      result.creator = reader.pubkey();
    }

    if (kind === "create_v2" && reader.remaining >= 1) {
      result.isMayhemMode = reader.bool();
    }

    if (kind === "create_v2" && reader.remaining >= 1) {
      result.isCashbackEnabled = reader.optionBool();
    }

    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extraction and diagnostics
// ---------------------------------------------------------------------------

interface ExtractStats {
  instructions: number;
  creates: number;
  uncommitted: number;
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
  discriminators: Map<string, number>;
}

export function extractCreates(block: PortalBlock): ExtractResult {
  const transactions = block.transactions ?? [];

  const instructions = block.instructions ?? [];

  const stats: ExtractStats = {
    instructions: instructions.length,
    creates: 0,
    uncommitted: 0,
    unknownDiscriminators: 0,
    decodeFailures: 0,
    accountLayoutFailures: 0,
    missingTransactions: 0,
    failedTransactions: 0,
    missingSignatures: 0,
  };

  const discriminators = new Map<string, number>();

  const txByIndex = new Map(
    transactions.map((transaction) => [
      transaction.transactionIndex,
      transaction,
    ]),
  );

  const events: NewTokenEvent[] = [];

  for (const instruction of instructions) {
    if (instruction.programId !== PUMP_PROGRAM) {
      continue;
    }

    if (instruction.isCommitted === false) {
      stats.uncommitted++;
      continue;
    }

    if (!instruction.data || !instruction.accounts) {
      stats.decodeFailures++;
      continue;
    }

    let data: Uint8Array;

    try {
      data = base58Decode(instruction.data);
    } catch {
      stats.decodeFailures++;
      continue;
    }

    const descriptor =
      data.length >= 8
        ? `0x${hex(data.subarray(0, 8))}`
        : `short:${data.length}`;

    discriminators.set(descriptor, (discriminators.get(descriptor) ?? 0) + 1);

    const kind = createInstructionKind(data);

    if (!kind) {
      stats.unknownDiscriminators++;
      continue;
    }

    const layout = CREATE_LAYOUT[kind];

    if (instruction.accounts.length < layout.minAccounts) {
      stats.accountLayoutFailures++;
      continue;
    }

    const args = decodeCreateArgs(data);

    if (!args) {
      stats.decodeFailures++;
      continue;
    }

    const transaction = txByIndex.get(instruction.transactionIndex);

    if (!transaction) {
      stats.missingTransactions++;
      continue;
    }

    if (transaction.err) {
      stats.failedTransactions++;
      continue;
    }

    const signature = transaction.signatures?.[0];

    if (!signature) {
      stats.missingSignatures++;
      continue;
    }

    const mint = instruction.accounts[layout.mint];

    const bondingCurve = instruction.accounts[layout.bondingCurve];

    const user = instruction.accounts[layout.user];

    if (!mint || !bondingCurve || !user) {
      stats.accountLayoutFailures++;
      continue;
    }

    const instructionAddress = Array.isArray(instruction.instructionAddress)
      ? [...instruction.instructionAddress]
      : [];

    events.push({
      id: `${signature}:` + instructionAddress.join("."),
      signature,
      instructionAddress,
      instructionKind: kind,
      slot: block.header.number,
      blockHeight: block.header.height,
      blockHash: block.header.hash,
      timestampMs: timestampToMs(block.header.timestamp),
      detectedAt: Date.now(),
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      mint,
      bondingCurve,
      user,
      creator: args.creator ?? user,
      isMayhemMode: args.isMayhemMode,
      isCashbackEnabled: args.isCashbackEnabled,
      viaCpi: instructionAddress.length > 1,
    });

    stats.creates++;
  }

  return {
    events,
    stats,
    discriminators,
  };
}

// ---------------------------------------------------------------------------
// Bounded caches
// ---------------------------------------------------------------------------

class LruSet {
  readonly #values = new Set<string>();

  constructor(readonly capacity: number) {}

  addIfNew(value: string): boolean {
    if (this.#values.has(value)) {
      return false;
    }

    this.#values.add(value);

    if (this.#values.size > this.capacity) {
      const oldest = this.#values.values().next().value;

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

interface HeaderPoint {
  number: number;
  hash: string;
}

class RecentHeaders {
  readonly #values = new Map<number, string>();

  constructor(readonly capacity = 512) {}

  add(number: number, hash: string): void {
    this.#values.set(number, hash);

    while (this.#values.size > this.capacity) {
      const oldest = this.#values.keys().next().value;

      if (oldest !== undefined) {
        this.#values.delete(oldest);
      }
    }
  }

  findCommon(previous: HeaderPoint[]): HeaderPoint | null {
    for (const point of previous) {
      if (this.#values.get(point.number) === point.hash) {
        return point;
      }
    }

    return null;
  }

  removeAfter(number: number): void {
    for (const key of this.#values.keys()) {
      if (key > number) {
        this.#values.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime status and logging
// ---------------------------------------------------------------------------

interface RuntimeStatus {
  startedAtMs: number;
  lastRequestAtMs: number;
  lastResponseAtMs: number;
  lastBlockAtMs: number;
  lastCreateAtMs: number;

  cursor: number;
  parentBlockHash?: string;
  sourceHead: number;
  finalizedHead: number;

  requests: number;
  noDataResponses: number;
  httpBytes: number;
  blocks: number;
  instructions: number;
  creates: number;
  duplicates: number;
  continuations: number;
  forks: number;
  rateLimits: number;
  errors: number;

  uncommitted: number;
  decodeFailures: number;
  accountLayoutFailures: number;
  unknownDiscriminators: number;
  missingTransactions: number;
  failedTransactions: number;
  missingSignatures: number;

  discriminatorCounts: Map<string, number>;
}

function createStatus(cursor: number, sourceHead: number): RuntimeStatus {
  return {
    startedAtMs: Date.now(),
    lastRequestAtMs: 0,
    lastResponseAtMs: 0,
    lastBlockAtMs: 0,
    lastCreateAtMs: 0,

    cursor,
    sourceHead,
    finalizedHead: 0,

    requests: 0,
    noDataResponses: 0,
    httpBytes: 0,
    blocks: 0,
    instructions: 0,
    creates: 0,
    duplicates: 0,
    continuations: 0,
    forks: 0,
    rateLimits: 0,
    errors: 0,

    uncommitted: 0,
    decodeFailures: 0,
    accountLayoutFailures: 0,
    unknownDiscriminators: 0,
    missingTransactions: 0,
    failedTransactions: 0,
    missingSignatures: 0,

    discriminatorCounts: new Map(),
  };
}

function mergeCounts(
  target: Map<string, number>,
  source: Map<string, number>,
): void {
  for (const [key, count] of source) {
    target.set(key, (target.get(key) ?? 0) + count);
  }
}

function topCounts(
  values: Map<string, number>,
  limit = 10,
): Record<string, number> {
  return Object.fromEntries(
    [...values.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit),
  );
}

function ageMs(value: number): number | null {
  return value === 0 ? null : Date.now() - value;
}

function startHeartbeat(
  status: RuntimeStatus,
  mode: FilterMode,
  dedupe: LruSet,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    m.sync(
      {
        start: () => "heartbeat",
        end: (value) => value,
        summarize: false,
        maxResultLength: 4_000,
      },
      () => ({
        mode,
        finalized: USE_FINALIZED,
        endpoint: USE_FINALIZED ? "finalized-stream" : "stream",
        cursor: status.cursor,
        sourceHead: status.sourceHead,
        finalizedHead: status.finalizedHead || null,
        slotLag: Math.max(0, status.sourceHead - status.cursor),
        uptimeMs: Date.now() - status.startedAtMs,
        lastRequestAgeMs: ageMs(status.lastRequestAtMs),
        lastResponseAgeMs: ageMs(status.lastResponseAtMs),
        lastBlockAgeMs: ageMs(status.lastBlockAtMs),
        lastCreateAgeMs: ageMs(status.lastCreateAtMs),
        requests: status.requests,
        noData: status.noDataResponses,
        httpMiB: Number((status.httpBytes / 1024 / 1024).toFixed(3)),
        blocks: status.blocks,
        instructions: status.instructions,
        creates: status.creates,
        duplicates: status.duplicates,
        dedupeSize: dedupe.size,
        continuations: status.continuations,
        forks: status.forks,
        rateLimits: status.rateLimits,
        errors: status.errors,
        decodeFailures: status.decodeFailures,
        layoutFailures: status.accountLayoutFailures,
        unknownDiscriminators: status.unknownDiscriminators,
        missingTransactions: status.missingTransactions,
        failedTransactions: status.failedTransactions,
        missingSignatures: status.missingSignatures,
        topDiscriminators: topCounts(status.discriminatorCounts),
      }),
    );
  }, HEARTBEAT_MS);

  (timer as any).unref?.();

  return timer;
}

// ---------------------------------------------------------------------------
// Direct Portal HTTP client
// ---------------------------------------------------------------------------

class PortalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly query?: PortalQuery,
  ) {
    super(`SQD Portal HTTP ${status}: ` + responseBody.slice(0, 2_000));

    this.name = "PortalHttpError";
  }
}

class PortalForkError extends Error {
  constructor(readonly previousBlocks: HeaderPoint[]) {
    super("SQD Portal reported a hot-chain fork");

    this.name = "PortalForkError";
  }
}

function portalHeaders(response: Response): PortalHeaders {
  return {
    headNumber: parseOptionalInteger(response.headers.get("x-sqd-head-number")),
    finalizedHeadNumber: parseOptionalInteger(
      response.headers.get("x-sqd-finalized-head-number"),
    ),
    finalizedHeadHash:
      response.headers.get("x-sqd-finalized-head-hash") ?? undefined,
    dataSource: response.headers.get("x-sqd-data-source") ?? undefined,
  };
}

async function fetchHead(): Promise<PortalHead> {
  const endpoint = USE_FINALIZED ? "finalized-head" : "head";

  return await m(
    {
      start: () => `GET ${endpoint}`,
      end: (head) => head,
      budget: 3_000,
    },
    async () => {
      const response = await fetch(`${PORTAL_URL}/${endpoint}`, {
        headers: {
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new PortalHttpError(response.status, await response.text());
      }

      const value = (await response.json()) as PortalHead | null;

      if (
        !value ||
        !Number.isSafeInteger(value.number) ||
        typeof value.hash !== "string"
      ) {
        throw new Error(`Portal ${endpoint} returned no valid head`);
      }

      return value;
    },
  );
}

function buildQuery(
  fromBlock: number,
  toBlock: number | undefined,
  parentBlockHash: string | undefined,
  mode: FilterMode,
): PortalQuery {
  const filter: PortalInstructionFilter = {
    programId: [PUMP_PROGRAM],
    isCommitted: true,
    transaction: true,
  };

  if (mode === "strict") {
    filter.d8 = [CREATE_D8, CREATE_V2_D8];
  }

  return {
    type: "solana",
    fromBlock,
    ...(toBlock === undefined ? {} : { toBlock }),
    ...(parentBlockHash === undefined ? {} : { parentBlockHash }),
    fields: {
      block: {
        number: true,
        hash: true,
        parentNumber: true,
        parentHash: true,
        height: true,
        timestamp: true,
      },
      transaction: {
        transactionIndex: true,
        signatures: true,
        err: true,
      },
      instruction: {
        transactionIndex: true,
        instructionAddress: true,
        programId: true,
        accounts: true,
        data: true,
        isCommitted: true,
      },
    },
    instructions: [filter],
  };
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<{
  block: PortalBlock;
  bytes: number;
}> {
  const reader = body.getReader();

  const decoder = new TextDecoder("utf-8");

  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newline = buffer.indexOf("\n");

        if (newline < 0) break;

        const line = buffer.slice(0, newline).trim();

        buffer = buffer.slice(newline + 1);

        if (!line) continue;

        yield {
          block: JSON.parse(line) as PortalBlock,
          bytes: Buffer.byteLength(line),
        };
      }
    }

    buffer += decoder.decode();

    const finalLine = buffer.trim();

    if (finalLine) {
      yield {
        block: JSON.parse(finalLine) as PortalBlock,
        bytes: Buffer.byteLength(finalLine),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

interface StreamRequestResult {
  summary: PortalBatchSummary;
  lastHeader?: HeaderPoint;
}

async function requestStreamBatch(
  query: PortalQuery,
  onBlock: (block: PortalBlock) => Promise<void>,
): Promise<StreamRequestResult> {
  const endpoint = USE_FINALIZED ? "finalized-stream" : "stream";

  return await m(
    {
      start: () =>
        `POST ${endpoint} from=${query.fromBlock}` +
        (query.toBlock === undefined ? "" : ` to=${query.toBlock}`),
      end: (result) => result.summary,
      budget: 10_000,
      maxResultLength: 2_000,
    },
    async () => {
      const response = await fetch(`${PORTAL_URL}/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson, application/json",
          "accept-encoding": "gzip, br",
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const headers = portalHeaders(response);

      if (response.status === 204) {
        return {
          summary: {
            httpStatus: 204,
            blocks: 0,
            bytes: 0,
            headNumber: headers.headNumber,
            finalizedHeadNumber: headers.finalizedHeadNumber,
            dataSource: headers.dataSource,
          },
        };
      }

      if (response.status === 409) {
        const raw = await response.text();

        let parsed: PortalConflictBody = {};

        try {
          parsed = JSON.parse(raw) as PortalConflictBody;
        } catch {
          throw new PortalHttpError(409, raw, query);
        }

        throw new PortalForkError(parsed.previousBlocks ?? []);
      }

      if (response.status === 429) {
        const body = await response.text();

        const wait = retryAfterMs(response, RETRY_MS);

        const error = new PortalHttpError(
          429,
          body,
          query,
        ) as PortalHttpError & {
          retryAfterMs?: number;
        };

        error.retryAfterMs = wait;
        throw error;
      }

      if (!response.ok) {
        throw new PortalHttpError(
          response.status,
          await response.text(),
          query,
        );
      }

      if (!response.body) {
        throw new Error("Portal returned 200 without a response body");
      }

      let blocks = 0;
      let bytes = 0;
      let firstSlot: number | undefined;
      let lastSlot: number | undefined;
      let lastHeader: HeaderPoint | undefined;

      for await (const item of readNdjson(response.body)) {
        const block = item.block;

        if (
          !block.header ||
          !Number.isSafeInteger(block.header.number) ||
          typeof block.header.hash !== "string"
        ) {
          throw new Error("Portal returned a malformed block header");
        }

        blocks++;
        bytes += item.bytes;

        firstSlot ??= block.header.number;

        lastSlot = block.header.number;

        lastHeader = {
          number: block.header.number,
          hash: block.header.hash,
        };

        await onBlock(block);
      }

      return {
        summary: {
          httpStatus: response.status,
          blocks,
          bytes,
          firstSlot,
          lastSlot,
          headNumber: headers.headNumber,
          finalizedHeadNumber: headers.finalizedHeadNumber,
          dataSource: headers.dataSource,
        },
        lastHeader,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const requestedFrom = parseNumberFlag("--from");

  const requestedTo = parseNumberFlag("--to");

  const probe = hasFlag("--probe");

  if (requestedTo !== undefined && requestedFrom === undefined) {
    throw new Error("--to requires --from");
  }

  if (
    requestedFrom !== undefined &&
    requestedTo !== undefined &&
    requestedTo < requestedFrom
  ) {
    throw new Error("--to must be greater than or equal to --from");
  }

  const head = await fetchHead();

  const mode: FilterMode = probe ? "program" : FILTER_MODE;

  let cursor: number;
  let to: number | undefined;

  if (probe) {
    to = head.number;

    cursor = Math.max(0, head.number - PROBE_SLOTS);
  } else if (requestedFrom !== undefined) {
    cursor = requestedFrom;

    to = requestedTo;
  } else {
    cursor = Math.max(0, head.number - LIVE_LOOKBACK);

    to = undefined;
  }

  const status = createStatus(cursor, head.number);

  const dedupe = new LruSet(DEDUPE_SIZE);

  const recentHeaders = new RecentHeaders();

  const heartbeat = startHeartbeat(status, mode, dedupe);

  let running = true;

  const stop = (signal: string) => {
    running = false;

    clearInterval(heartbeat);

    m.note({
      start: () => `stop ${signal}`,
    });
  };

  process.once("SIGINT", () => stop("SIGINT"));

  process.once("SIGTERM", () => stop("SIGTERM"));

  const initialQuery = buildQuery(cursor, to, undefined, mode);

  m.sync(
    {
      start: () => "startup",
      end: (value) => value,
      summarize: false,
      maxResultLength: 4_000,
    },
    () => ({
      portal: PORTAL_URL,
      endpoint: USE_FINALIZED ? "finalized-stream" : "stream",
      mode,
      probe,
      program: PUMP_PROGRAM,
      discriminators: [CREATE_D8, CREATE_V2_D8],
      head: head.number,
      from: cursor,
      to: to ?? null,
      lookback: requestedFrom === undefined && !probe ? LIVE_LOOKBACK : null,
      query: LOG_QUERY ? initialQuery : "set SQD_LOG_QUERY=1 to print",
    }),
  );

  const onToken = async (event: NewTokenEvent): Promise<void> => {
    const lag =
      event.timestampMs === null
        ? "n/a"
        : event.detectedAt - event.timestampMs + "ms";

    console.log(
      "\n" +
        `🚀 ${event.name} ($${event.symbol})` +
        ` [${event.instructionKind}]` +
        (event.viaCpi ? " [via CPI]" : "") +
        "\n" +
        `   mint     ${event.mint}\n` +
        `   curve    ${event.bondingCurve}\n` +
        `   user     ${event.user}\n` +
        `   creator  ${event.creator}\n` +
        `   sig      ${event.signature}\n` +
        `   ix       ${event.instructionAddress.join(".")}\n` +
        `   slot     ${event.slot}` +
        (event.blockHeight === undefined
          ? ""
          : ` height ${event.blockHeight}`) +
        ` lag ${lag}` +
        (event.isMayhemMode === undefined
          ? ""
          : ` mayhem=${event.isMayhemMode}`) +
        (event.isCashbackEnabled === undefined
          ? ""
          : ` cashback=${String(event.isCashbackEnabled)}`),
    );

    // Production seam:
    // - Upsert by event.id.
    // - Feed event.bondingCurve into Case 2.
    // - In hot mode, mark the row provisional until finalized.
  };

  while (running) {
    if (to !== undefined && cursor > to) {
      break;
    }

    const query = buildQuery(cursor, to, status.parentBlockHash, mode);

    status.lastRequestAtMs = Date.now();

    status.requests++;

    try {
      const result = await requestStreamBatch(query, async (block) => {
        const extracted = await m(
          {
            start: () => `block ${block.header.number}`,
            end: (value) => ({
              instructions: value.stats.instructions,
              creates: value.stats.creates,
              decodeFailures: value.stats.decodeFailures,
            }),
            budget: 50,
          },
          async () => extractCreates(block),
        );

        status.blocks++;
        status.lastBlockAtMs = Date.now();

        status.instructions += extracted.stats.instructions;

        status.uncommitted += extracted.stats.uncommitted;

        status.decodeFailures += extracted.stats.decodeFailures;

        status.accountLayoutFailures += extracted.stats.accountLayoutFailures;

        status.unknownDiscriminators += extracted.stats.unknownDiscriminators;

        status.missingTransactions += extracted.stats.missingTransactions;

        status.failedTransactions += extracted.stats.failedTransactions;

        status.missingSignatures += extracted.stats.missingSignatures;

        mergeCounts(status.discriminatorCounts, extracted.discriminators);

        for (const event of extracted.events) {
          if (!dedupe.addIfNew(event.id)) {
            status.duplicates++;
            continue;
          }

          await onToken(event);

          status.creates++;
          status.lastCreateAtMs = Date.now();
        }

        recentHeaders.add(block.header.number, block.header.hash);

        cursor = block.header.number + 1;

        status.cursor = cursor;

        status.parentBlockHash = block.header.hash;
      });

      status.lastResponseAtMs = Date.now();

      status.httpBytes += result.summary.bytes;

      if (result.summary.headNumber !== undefined) {
        status.sourceHead = result.summary.headNumber;
      }

      if (result.summary.finalizedHeadNumber !== undefined) {
        status.finalizedHead = result.summary.finalizedHeadNumber;
      }

      if (result.summary.httpStatus === 204 || result.summary.blocks === 0) {
        status.noDataResponses++;

        if (to !== undefined && status.sourceHead >= to) {
          // A finite range with no further matching rows is complete once
          // the source has reached the requested end.
          cursor = to + 1;
          status.cursor = cursor;
          break;
        }

        await sleep(POLL_MS);
      } else {
        // The response ended normally. Portal responses are batches, not
        // permanent streams; immediately continue from the last returned slot.
        status.continuations++;
      }
    } catch (error) {
      status.lastResponseAtMs = Date.now();

      if (error instanceof PortalForkError) {
        status.forks++;
        status.errors++;

        const common = recentHeaders.findCommon(error.previousBlocks);

        if (common) {
          cursor = common.number + 1;

          status.cursor = cursor;

          status.parentBlockHash = common.hash;

          recentHeaders.removeAfter(common.number);

          console.warn(
            `[sqd] fork: resumed after common slot ${common.number}`,
          );
        } else {
          cursor = Math.max(0, cursor - REORG_REWIND);

          status.cursor = cursor;

          status.parentBlockHash = undefined;

          console.warn(
            `[sqd] fork: no cached common ancestor; rewinding ${REORG_REWIND} slots to ${cursor}`,
          );
        }

        continue;
      }

      if (error instanceof PortalHttpError && error.status === 429) {
        status.rateLimits++;

        const wait =
          (
            error as PortalHttpError & {
              retryAfterMs?: number;
            }
          ).retryAfterMs ?? RETRY_MS;

        console.warn(`[sqd] rate limited; retrying in ${wait}ms`);

        await sleep(wait);
        continue;
      }

      status.errors++;

      if (error instanceof PortalHttpError) {
        console.error(
          `[sqd] HTTP ${error.status}\n` +
            `response: ${error.responseBody}\n` +
            (error.query
              ? `query: ${JSON.stringify(error.query, null, 2)}`
              : ""),
        );

        // 400 is a deterministic malformed query; repeated retries only
        // hide the request body. Exit so the exact payload remains visible.
        if (error.status === 400) {
          throw error;
        }
      } else {
        console.error(`[sqd] ${errorMessage(error)}`);
      }

      console.warn(`[sqd] retrying from slot ${cursor} in ${RETRY_MS}ms`);

      await sleep(RETRY_MS);
    }
  }

  clearInterval(heartbeat);

  m.sync(
    {
      start: () => "complete",
      end: (value) => value,
      summarize: false,
      maxResultLength: 4_000,
    },
    () => ({
      mode,
      from: initialQuery.fromBlock,
      to: to ?? null,
      cursor,
      requests: status.requests,
      blocks: status.blocks,
      instructions: status.instructions,
      creates: status.creates,
      duplicates: status.duplicates,
      httpBytes: status.httpBytes,
      errors: status.errors,
      topDiscriminators: topCounts(status.discriminatorCounts),
    }),
  );
}

if (import.meta.main) {
  await m
    .root(
      {
        start: () => "SQD Pump listener",
        end: () => ({
          stopped: true,
        }),
      },
      main,
    )
    .catch((error) => {
      console.error("[sqd] fatal:", error);

      process.exitCode = 1;
    });
}
