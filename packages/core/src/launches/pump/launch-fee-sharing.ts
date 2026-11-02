import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';

/** A new, untraded SOL curve has no accrued fees to sweep. */
export async function buildInitialPumpFeeSharing(args: {
  creator: PublicKey;
  mint: PublicKey;
  shareholders: Array<{ address: string; shareBps: number }>;
}) {
  return [
    await PUMP_SDK.createFeeSharingConfig({creator:args.creator,mint:args.mint,pool:null}),
    await PUMP_SDK.updateFeeShares({authority:args.creator,mint:args.mint,
      currentShareholders:[args.creator],bondingCurveComplete:false,
      newShareholders:args.shareholders.map(row=>({address:new PublicKey(row.address),shareBps:row.shareBps})),
    }),
  ];
}
