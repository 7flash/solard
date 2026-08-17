import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

export function transferSolIx(
  from: PublicKey,
  to: PublicKey,
  lamports: bigint,
): TransactionInstruction {
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("SOL transfer exceeds JS safe integer boundary");
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: to,
    lamports: Number(lamports),
  });
}

export function transferTokenIxs(args: {
  payer: PublicKey;
  owner: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  amountRaw: bigint;
  decimals: number;
  tokenProgram: PublicKey;
}): {
  instructions: TransactionInstruction[];
  source: PublicKey;
  destination: PublicKey;
} {
  const source = getAssociatedTokenAddressSync(
    args.mint,
    args.owner,
    false,
    args.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    args.mint,
    args.recipient,
    false,
    args.tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return {
    source,
    destination,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        args.payer,
        destination,
        args.recipient,
        args.mint,
        args.tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        source,
        args.mint,
        destination,
        args.owner,
        args.amountRaw,
        args.decimals,
        [],
        args.tokenProgram,
      ),
    ],
  };
}

export function closeTokenAccountIx(args: {
  account: PublicKey;
  owner: PublicKey;
  destination?: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  return createCloseAccountInstruction(
    args.account,
    args.destination ?? args.owner,
    args.owner,
    [],
    args.tokenProgram ?? TOKEN_PROGRAM_ID,
  );
}

export function wrappedSolAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export function unwrapWsolIx(
  owner: PublicKey,
  destination: PublicKey = owner,
): TransactionInstruction {
  return createCloseAccountInstruction(
    wrappedSolAta(owner),
    destination,
    owner,
    [],
    TOKEN_PROGRAM_ID,
  );
}

export function unwrapWsolIxs(args: {
  owner: PublicKey;
  destination?: PublicKey;
}): {
  instructions: TransactionInstruction[];
  account: PublicKey;
  destination: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
} {
  const destination = args.destination ?? args.owner;
  const account = wrappedSolAta(args.owner);
  return {
    account,
    destination,
    mint: NATIVE_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
    instructions: [
      createCloseAccountInstruction(
        account,
        destination,
        args.owner,
        [],
        TOKEN_PROGRAM_ID,
      ),
    ],
  };
}
