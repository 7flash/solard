import bs58 from "bs58";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { findExternalContact, type Solard } from "@solard/core";

type Flags = Map<string, string>;
type Emit = (value: string) => void;
type LoaderKind = "buffer" | "program";

type LoaderRow = {
  kind: LoaderKind;
  walletName: string;
  authority: string;
  address: string;
  closeAddress: string;
  programDataAddress: string | null;
  lamports: bigint;
};

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOSE_DISCRIMINANT = 5;
const STATE_BUFFER = bs58.encode(Buffer.from([1, 0, 0, 0]));
const STATE_PROGRAM = bs58.encode(Buffer.from([2, 0, 0, 0]));
const STATE_PROGRAM_DATA = bs58.encode(Buffer.from([3, 0, 0, 0]));

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function short(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}

function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function selectedWallets(slrd: Solard, flags: Flags) {
  const all = flags.has("all-wallets");
  const wallet = flags.get("wallet");
  const wallets = csv(flags.get("wallets"));
  const group = flags.get("group");
  const selectors = [
    all,
    Boolean(wallet),
    wallets.length > 0,
    Boolean(group),
  ].filter(Boolean).length;
  if (selectors !== 1) {
    throw new Error(
      "Select exactly one of --all-wallets, --wallet <wallet>, --wallets <a,b>, or --group <group>.",
    );
  }
  const allRows = slrd.wallets.list();
  let addresses: Set<string>;
  if (all) {
    addresses = new Set(allRows.map((row) => row.address));
  } else if (wallet) {
    addresses = new Set([slrd.resolveWallet(wallet).address.toBase58()]);
  } else if (wallets.length) {
    addresses = new Set(
      wallets.map((ref) => slrd.resolveWallet(ref).address.toBase58()),
    );
  } else {
    addresses = new Set(
      slrd
        .groupWallets(group!)
        .map((ref) => slrd.resolveWallet(ref).address.toBase58()),
    );
  }
  return allRows.filter((row) => addresses.has(row.address));
}

async function scanAuthority(
  slrd: Solard,
  wallet: { name: string; address: string },
): Promise<LoaderRow[]> {
  const connection = slrd.connection();
  const buffers = await connection.getProgramAccounts(LOADER, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: STATE_BUFFER } },
      { memcmp: { offset: 5, bytes: wallet.address } },
    ],
    dataSlice: { offset: 0, length: 37 },
  });
  const programData = await connection.getProgramAccounts(LOADER, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: STATE_PROGRAM_DATA } },
      { memcmp: { offset: 13, bytes: wallet.address } },
    ],
    dataSlice: { offset: 0, length: 45 },
  });

  const rows: LoaderRow[] = buffers.map((entry) => ({
    kind: "buffer",
    walletName: wallet.name,
    authority: wallet.address,
    address: entry.pubkey.toBase58(),
    closeAddress: entry.pubkey.toBase58(),
    programDataAddress: null,
    lamports: BigInt(entry.account.lamports),
  }));

  for (const entry of programData) {
    const programDataAddress = entry.pubkey.toBase58();
    const programs = await connection.getProgramAccounts(LOADER, {
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: STATE_PROGRAM } },
        { memcmp: { offset: 4, bytes: programDataAddress } },
      ],
      dataSlice: { offset: 0, length: 36 },
    });
    for (const program of programs) {
      rows.push({
        kind: "program",
        walletName: wallet.name,
        authority: wallet.address,
        address: program.pubkey.toBase58(),
        closeAddress: programDataAddress,
        programDataAddress,
        lamports: BigInt(entry.account.lamports),
      });
    }
  }
  return rows;
}

function resolveDestination(
  slrd: Solard,
  value: string | undefined,
): string | null {
  if (!value || value === "true") return null;
  try {
    return slrd.resolveWallet(value).address.toBase58();
  } catch {}
  const contact = findExternalContact(value);
  if (contact) return contact.address;
  return new PublicKey(value).toBase58();
}

function closeInstruction(
  row: LoaderRow,
  destination: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(CLOSE_DISCRIMINANT, 0);
  const keys = [
    {
      pubkey: new PublicKey(row.closeAddress),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(row.authority), isSigner: true, isWritable: false },
  ];
  if (row.kind === "program") {
    keys.push({
      pubkey: new PublicKey(row.address),
      isSigner: false,
      isWritable: true,
    });
  }
  return new TransactionInstruction({ programId: LOADER, keys, data });
}

async function verifyClosed(slrd: Solard, address: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const account = await slrd
      .connection()
      .getAccountInfo(new PublicKey(address), "confirmed");
    if (!account || account.lamports === 0) return true;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function runReclaimCommand(args: {
  slrd: Solard;
  values: string[];
  flags: Flags;
  emit: Emit;
}): Promise<void> {
  const action = (args.values[0] ?? "inspect").toLowerCase();
  if (!["inspect", "buffers", "programs", "all"].includes(action)) {
    throw new Error(
      "Usage: slrd reclaim <inspect|buffers|programs|all> --all-wallets [--simulate | --live]",
    );
  }
  if (args.flags.has("simulate") && args.flags.has("live"))
    throw new Error("Use either --simulate or --live, not both.");

  const wallets = selectedWallets(args.slrd, args.flags);
  const rows: LoaderRow[] = [];
  const scanErrors: Array<{ wallet: string; address: string; error: string }> =
    [];
  for (const wallet of wallets) {
    try {
      rows.push(...(await scanAuthority(args.slrd, wallet)));
    } catch (error) {
      scanErrors.push({
        wallet: wallet.name,
        address: wallet.address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const selected = rows.filter((row) =>
    action === "inspect" || action === "all"
      ? true
      : action === "buffers"
        ? row.kind === "buffer"
        : row.kind === "program",
  );
  selected.sort(
    (a, b) =>
      a.walletName.localeCompare(b.walletName) || a.kind.localeCompare(b.kind),
  );
  const total = selected.reduce((sum, row) => sum + row.lamports, 0n);

  if (
    args.flags.has("json") &&
    !args.flags.has("live") &&
    !args.flags.has("simulate")
  ) {
    args.emit(
      `${json({ wallets: wallets.length, rows: selected, scanErrors, totalLamports: total })}\n`,
    );
    return;
  }

  args.emit(
    `RECLAIM  wallets=${wallets.length} buffers=${selected.filter((row) => row.kind === "buffer").length} ` +
      `programs=${selected.filter((row) => row.kind === "program").length} total≈${sol(total)} SOL\n`,
  );
  for (const row of selected) {
    args.emit(
      `${row.kind === "buffer" ? "BUFFER " : "PROGRAM"}  @${row.walletName}  ${short(row.address)}  ${sol(row.lamports)} SOL\n`,
    );
  }
  for (const error of scanErrors) {
    args.emit(`SCANERR  @${error.wallet} ${error.address}  ${error.error}\n`);
  }

  if (
    action === "inspect" ||
    (!args.flags.has("simulate") && !args.flags.has("live"))
  ) {
    args.emit("No accounts closed. Use --simulate, then --live.\n");
    return;
  }
  if (scanErrors.length) {
    throw new Error(
      `Loader scan was incomplete for ${scanErrors.length} wallet(s); refusing reclaim execution.`,
    );
  }
  if (
    args.flags.has("live") &&
    selected.some((row) => row.kind === "program") &&
    !args.flags.has("confirm-program-close")
  ) {
    throw new Error(
      "Program closure is irreversible. Re-run with --confirm-program-close together with --live.",
    );
  }

  const explicitDestination = resolveDestination(
    args.slrd,
    args.flags.get("destination"),
  );
  const via = (args.flags.get("sender") ?? "rpc") as any;
  let ok = 0;
  let failed = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const row = selected[index]!;
    const destination = new PublicKey(explicitDestination ?? row.authority);
    const ix = closeInstruction(row, destination);
    try {
      const composer = args.slrd.tx(row.walletName).add(ix, {
        kind: `close-loader-${row.kind}`,
        recipient: destination,
        meta: { address: row.address, closeAddress: row.closeAddress },
      });
      if (args.flags.has("simulate")) {
        const plan = await composer.build();
        const simulation = await args.slrd.simulatePlan(plan);
        if (!simulation.success) throw new Error("simulation failed");
        args.emit(
          `SIM  ${index + 1}/${selected.length}  ${row.kind} ${row.address}\n`,
        );
      } else {
        const receipt = await composer.send({
          via,
          kind: `reclaim:${row.kind}`,
        });
        if (!(await verifyClosed(args.slrd, row.closeAddress))) {
          throw new Error(
            `close transaction ${receipt.signature} landed but ${row.closeAddress} still exists`,
          );
        }
        args.emit(
          `OK   ${index + 1}/${selected.length}  ${row.kind} ${row.address}  reclaimed≈${sol(row.lamports)} SOL\n`,
        );
      }
      ok += 1;
    } catch (error) {
      failed += 1;
      args.emit(
        `FAIL ${index + 1}/${selected.length}  ${row.kind} ${row.address}  ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  args.emit(
    `DONE  ok=${ok} failed=${failed} planned≈${sol(total)} SOL mode=${args.flags.has("simulate") ? "simulate" : "live"}\n`,
  );
  if (failed) process.exitCode = 1;
}
