import { PublicKey } from "@solana/web3.js";

export const address = (seed: number) => new PublicKey(Buffer.alloc(32, seed));
export function portalBlock(slot: number, accounts: string[], data: Array<{ program: string; bytes: Buffer }>, signature = `signature-${slot}`) {
  return {
    header: { number: slot, hash: `hash-${slot}`, parentNumber: slot - 1, parentHash: `hash-${slot - 1}`, timestamp: Math.floor(Date.now() / 1000) },
    transactions: [{ transactionIndex: 7, signatures: [signature], accountKeys: accounts, err: null }],
    logs: data.map((item, index) => ({ transactionIndex: 7, logIndex: index * 3 + 1,
      programId: item.program, kind: "data", message: item.bytes.toString("base64") })),
  };
}

export function portalFixture(initial: unknown[] = []) {
  const blocks = [...initial];
  const requests: Array<{ url: string; query: Record<string, any> | null; at: number }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const query = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : null;
    requests.push({ url: String(input), query, at: performance.now() });
    if (!query) return Response.json({ number: 10, hash: "hash-10" });
    if (!blocks.length) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(blocks.shift()) + "\n");
  }) as unknown as typeof fetch;
  return { fetcher, requests, enqueue: (block: unknown) => blocks.push(block) };
}

export async function until(check: () => boolean): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > 1500) throw new Error("Fixture condition timed out");
    await Bun.sleep(5);
  }
}
