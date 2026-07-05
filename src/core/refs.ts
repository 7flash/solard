import { Keypair, PublicKey } from "@solana/web3.js";
import type { TokenRow, WalletRow } from "../db/schema.js";
export type WalletRef = string | PublicKey | Keypair | WalletRow;
export type TokenRef = string | PublicKey | TokenRow;
export type GroupRef = string;
