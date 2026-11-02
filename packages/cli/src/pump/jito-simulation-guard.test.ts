import {expect,test} from 'bun:test';
import {requireSkipSimulationForBlindLiveBuys} from './token-launch-cli.ts';
test('live Jito allows mandatory dependent bundle simulation while blind parallel buys retain their guard',()=>{
 expect(()=>requireSkipSimulationForBlindLiveBuys(true,'jito-bundle',false,true)).not.toThrow();
 expect(()=>requireSkipSimulationForBlindLiveBuys(true,'blind-spam-after-submit',false,true)).toThrow('requires --skip-simulation');
 expect(()=>requireSkipSimulationForBlindLiveBuys(true,'blind-spam-after-submit',true,true)).not.toThrow();
 expect(()=>requireSkipSimulationForBlindLiveBuys(false,'jito-bundle',false,true)).not.toThrow();
});
