import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { WalletRepo } from '../db/wallet-repo.ts';

/** Read every candidate successfully before changing selection state. No token-account scans. */
export async function ignoreZeroSolWallets(wallets: WalletRepo, connection: Pick<Connection, 'getMultipleAccountsInfoAndContext'>) {
  const candidates = wallets.list();
  const checked: Array<{ address: string; name: string; lamports: number; slot: number }> = [];
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const response = await connection.getMultipleAccountsInfoAndContext(batch.map(wallet => new PublicKey(wallet.address)), 'confirmed');
    if (response.value.length !== batch.length) throw new Error('Truncated wallet account response; nothing ignored');
    response.value.forEach((account, index) => {
      const lamports = account?.lamports ?? 0;
      if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('Invalid SOL balance; nothing ignored');
      checked.push({ address: batch[index]!.address, name: batch[index]!.name, lamports, slot: response.context.slot });
    });
  }
  const zero = checked.filter(wallet => wallet.lamports === 0);
  for (const wallet of zero) wallets.setIgnored(wallet.address);
  return { checked: checked.length, ignored: zero, retained: checked.length - zero.length };
}
