import { Connection, type Commitment } from "@solana/web3.js";
import { MissingConfigError } from "../core/errors.ts";

export class SolardConnection {
  private value?: Connection;
  constructor(
    private readonly rpcUrl?: string,
    private readonly commitment: Commitment = "confirmed",
  ) {}
  get(): Connection {
    if (this.value) return this.value;
    const url = this.rpcUrl ?? process.env.RPC_ENDPOINT;
    if (!url) throw new MissingConfigError("RPC_ENDPOINT or Solard({ rpcUrl })");
    this.value = new Connection(url, this.commitment);
    return this.value;
  }
}
