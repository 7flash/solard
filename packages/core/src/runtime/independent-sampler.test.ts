import{test,expect}from'bun:test';import{runIndependentSampler}from'./independent-sampler.ts';
test('slow trade and failed sample never block subsequent price sampling',async()=>{
 const controller=new AbortController();let calls=0,errors=0;
 const sampling=runIndependentSampler({intervalMs:5,signal:controller.signal,sample:async()=>{calls++;if(calls===2)throw Error('RPC');},onError:()=>errors++});
 await Bun.sleep(45); // Represents an outstanding awaited trade on the other task.
 controller.abort();await sampling;expect(calls).toBeGreaterThanOrEqual(4);expect(errors).toBe(1);
 const stopped=calls;await Bun.sleep(12);expect(calls).toBe(stopped);
});
