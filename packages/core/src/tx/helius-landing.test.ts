import { expect, spyOn, test } from "bun:test";
import { PublicKey, SystemInstruction } from "@solana/web3.js";
import { addHeliusLandingTip, HELIUS_TIP_ACCOUNTS } from "./helius-landing.ts";
import { HeliusSender, heliusSenderEndpoint } from "./senders/helius-sender.ts";
import type { TransactionDraft } from "./types.ts";

const payer = new PublicKey("11111111111111111111111111111111");
function empty(): TransactionDraft { return { instructions: [], actions: [], signers: [], trackedAccounts: [] }; }

test("SWQOS tip is materialized once and Max upgrades the same transfer", () => {
  const original = empty();
  const first = addHeliusLandingTip(original, payer, "helius-swqos");
  expect(first.tipLamports).toBe(5_000);
  expect(original.instructions).toHaveLength(0);
  const again = addHeliusLandingTip(first.draft, payer, "helius-swqos");
  expect(again.draft.instructions).toHaveLength(1);
  expect(again.draft.actions).toHaveLength(1);
  const max = addHeliusLandingTip(again.draft, payer, "helius-max");
  expect(max.tipLamports).toBe(1_000_000);
  expect(max.draft.instructions).toHaveLength(1);
  const transfer = SystemInstruction.decodeTransfer(max.draft.instructions[0]!);
  expect(transfer.lamports).toBe(1_000_000n);
  expect(HELIUS_TIP_ACCOUNTS).toContain(transfer.toPubkey.toBase58());
});

test("invalid minimum, destination and detached metadata are rejected", () => {
  expect(() => addHeliusLandingTip(empty(), payer, "helius-swqos", { tipLamports: 4_999 })).toThrow("at least 5000");
  expect(() => addHeliusLandingTip(empty(), payer, "helius-max", { tipLamports: 999_999 })).toThrow("at least 1000000");
  expect(() => addHeliusLandingTip(empty(), payer, "helius-swqos", { tipAccount: payer })).toThrow("published");
  const valid = addHeliusLandingTip(empty(), payer, "helius-swqos");
  expect(() => addHeliusLandingTip({ ...valid.draft, instructions: [] }, payer, "helius-swqos")).toThrow("matching instruction");
});

test("tier URL preserves authentication and other endpoint options", () => {
  const base = "https://sender.helius-rpc.com/fast?api-key=test-key&mev-protect=true";
  const swqos = new URL(heliusSenderEndpoint(base, "helius-swqos"));
  expect(swqos.searchParams.get("api-key")).toBe("test-key");
  expect(swqos.searchParams.get("swqos_only")).toBe("true");
  const max = new URL(heliusSenderEndpoint(swqos.toString(), "helius-max"));
  expect(max.searchParams.has("swqos_only")).toBe(false);
  expect(max.searchParams.get("mev-protect")).toBe("true");
});

test("Sender sends SWQOS to its explicit tier and honours preflight without signing", async () => {
  let capturedUrl = "";
  let body: any;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    capturedUrl = String(url);
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ result: "mock-signature" }), { status: 200 });
  });
  try {
    const sender = new HeliusSender("https://sender.helius-rpc.com/fast?api-key=test-key", "helius-swqos");
    const signature = await sender.send({
      connection: {} as any,
      transaction: { serialize: () => new Uint8Array([1, 2, 3]) } as any,
      options: { skipPreflight: false },
    });
    expect(signature).toBe("mock-signature");
    expect(new URL(capturedUrl).searchParams.get("swqos_only")).toBe("true");
    expect(body.params[1]).toEqual({ encoding: "base64", skipPreflight: false, maxRetries: 0 });
    expect(body.params[0]).toBe("AQID");
  } finally { fetchMock.mockRestore(); }
});
