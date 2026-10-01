import { findExternalContact } from "@solard/core";
import { PublicKey } from "@solana/web3.js";

export type ResolvedDestinationRef = {
  input: string;
  address: string;
  contactName?: string;
  walletName?: string;
};

type WalletResolver = {
  resolveWallet(ref: string): { address: { toBase58(): string } };
};

/**
 * Resolve a CLI destination without ever treating an external contact as a
 * signing wallet. Ambiguous contact/wallet names fail closed.
 */
export function resolveDestinationRef(
  slrd: WalletResolver,
  value: string,
): ResolvedDestinationRef {
  const input = value.trim();
  // A literal address needs no contact database lookup or schema initialization.
  try { return { input, address: new PublicKey(input).toBase58() }; } catch {}
  const contact = findExternalContact(input);

  let walletAddress: string | null = null;
  try {
    walletAddress = slrd.resolveWallet(input).address.toBase58();
  } catch {
    walletAddress = null;
  }

  if (contact && walletAddress && contact.address !== walletAddress) {
    throw new Error(
      `Ambiguous destination ${input}: external contact @${contact.name} points to ${contact.address}, ` +
        `but a stored signing wallet resolves to ${walletAddress}. Rename one of them.`,
    );
  }

  if (contact) {
    return {
      input,
      address: contact.address,
      contactName: contact.name,
    };
  }

  if (walletAddress) {
    return {
      input,
      address: walletAddress,
      walletName: input.replace(/^@/, ""),
    };
  }

  return { input, address: input };
}
