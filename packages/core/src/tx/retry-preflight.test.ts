import{test,expect}from'bun:test';import{retryPreflightSlippage}from'./retry-preflight.ts';import{TradePreSubmissionError}from'./trade-errors.ts';
test('rebuilds only proven pre-submission slippage, bounded and never ambiguous sends',async()=>{
 let calls=0,refresh=0;const failure=new TradePreSubmissionError(Object.assign(new Error('slippage'),{code:'SLIPPAGE'}));
 const value=await retryPreflightSlippage(3,async()=>{if(++calls<3)throw failure;return 'ok';},()=>refresh++);
 expect(value).toBe('ok');expect(calls).toBe(3);expect(refresh).toBe(2);
 calls=0;await expect(retryPreflightSlippage(3,async()=>{calls++;throw Error('RPC timeout after send');},()=>refresh++)).rejects.toThrow('RPC timeout');expect(calls).toBe(1);
 calls=0;await expect(retryPreflightSlippage(2,async()=>{calls++;throw failure;},()=>{})).rejects.toThrow();expect(calls).toBe(2);
});

