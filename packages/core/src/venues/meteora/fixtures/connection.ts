import { PublicKey, type Connection, type AccountInfo } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import bs58 from "bs58";
import snapshot from "./handoff-mainnet.json";

/** Frozen public mainnet accounts. This connection cannot send transactions. */
export function fixtureConnection() {
  const accounts = new Map<string, AccountInfo<Buffer>>(Object.entries(snapshot.accounts).map(([address, account]) => [address, {
    data: Buffer.from(account.data, "base64"), owner: new PublicKey(account.owner),
    lamports: account.lamports, executable: account.executable, rentEpoch: 0,
  }]));
  const callbacks: Array<(logs: { signature: string; err: unknown; logs: Array<string> }, context: { slot: number }) => void> = [];
  const connection = {
    async getAccountInfo(address: PublicKey) { return accounts.get(address.toBase58()) ?? null; },
    async getAccountInfoAndContext(address: PublicKey) { return { context: { slot: snapshot.slot }, value: accounts.get(address.toBase58()) ?? null }; },
    async getMultipleAccountsInfo(addresses: Array<PublicKey>) { return addresses.map((address) => accounts.get(address.toBase58()) ?? null); },
    async getProgramAccounts(program: PublicKey, options?: { filters?: Array<{ memcmp?: { offset: number; bytes: string }; dataSize?: number }> }) {
      return [...accounts].filter(([, account]) => account.owner.equals(program) && (options?.filters ?? []).every((filter) =>
        filter.memcmp ? account.data.subarray(filter.memcmp.offset, filter.memcmp.offset + bs58.decode(filter.memcmp.bytes).length).equals(Buffer.from(bs58.decode(filter.memcmp.bytes)))
          : filter.dataSize == null || account.data.length === filter.dataSize,
      )).map(([address, account]) => ({ pubkey: new PublicKey(address), account }));
    },
    async getTokenSupply(address: PublicKey) {
      const account = accounts.get(address.toBase58());
      if (!account) throw new Error("No fixture mint");
      const mint = unpackMint(address, account, account.owner);
      return { value: { decimals: mint.decimals, amount: mint.supply.toString() } };
    },
    async getSlot() { return snapshot.slot; },
    async getBlockTime() { return Math.floor(new Date(snapshot.capturedAt).getTime() / 1000); },
    async getEpochInfo() { return { epoch: Math.floor(snapshot.slot / 432_000) }; },
    onLogs(_filter: unknown, callback: typeof callbacks[number]) { callbacks.push(callback); return callbacks.length; },
    async removeOnLogsListener() {},
    async getParsedTransaction() { return null; },
  } as unknown as Connection;
  return { connection, accounts, callbacks, snapshot };
}
