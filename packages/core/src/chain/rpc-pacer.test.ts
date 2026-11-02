import {expect,test} from 'bun:test';
import {createRpcPacer} from './rpc-pacer.ts';
import {SolardConnection,solardConnectionFetch} from './connection.ts';
import type {FetchFn} from '@solana/web3.js';
import {observeSolardRpc} from './rpc-observer.ts';
const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'getSlot'});
test('rate admission counts physical starts after synchronous observer delay',async()=>{
 const starts:number[]=[];let delayed=false;
 const stop=observeSolardRpc(event=>{
  if(event.kind==='http'&&event.phase==='network'&&event.endpoint.includes('observer-delay.test')&&!delayed){delayed=true;Bun.sleepSync(40);}
 });
 try{
  const pacer=createRpcPacer({maxRps:1},(async()=>{starts.push(performance.now());return new Response('{}');}) as unknown as FetchFn);
  await Promise.all([pacer.fetch('https://observer-delay.test',{body}),pacer.fetch('https://observer-delay.test',{body})]);
  expect(delayed).toBe(true);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(1000);
 }finally{stop();}
});
test('50 parallel requests share a four-start sliding window',async()=>{
 const starts:number[]=[];
 const pacer=createRpcPacer({maxRps:4},(async()=>{starts.push(performance.now());return new Response('{}');}) as unknown as FetchFn);
 await Promise.all(Array.from({length:50},()=>pacer.fetch('https://pacing.test',{method:'POST',body})));
 expect(starts.at(-1)!-starts[0]!).toBeGreaterThanOrEqual(12000);
 for(const start of starts)expect(starts.filter(time=>time>=start&&time<start+1000).length).toBeLessThanOrEqual(4);
},20000);
test('429 pauses every queued request and honors Retry-After before retry',async()=>{
 const starts:number[]=[];
 const pacer=createRpcPacer({maxRps:100,maxConcurrent:1,retryOn429:{attempts:1}},(async()=>{
  starts.push(Date.now());return starts.length===1?new Response('',{status:429,headers:{'retry-after':'0.08'}}):new Response('{}');
 }) as unknown as FetchFn);
 const results=await Promise.all(Array.from({length:3},()=>pacer.fetch('https://pause.test',{method:'POST',body})));
 expect(results.every(result=>result.ok)).toBe(true);expect(starts).toHaveLength(4);
 expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(80);
});
test('concurrency is bounded, queued cancellation consumes no request and other endpoints progress',async()=>{
 let release!:()=>void;let active=0,peak=0,calls=0;
 const gate=new Promise<void>(resolve=>release=resolve);
 const pacer=createRpcPacer({maxRps:100,maxConcurrent:1},(async(input:Parameters<FetchFn>[0])=>{
  calls++;active++;peak=Math.max(peak,active);if(String(input).includes('blocked'))await gate;active--;return new Response('{}');
 }) as unknown as FetchFn);
 const first=pacer.fetch('https://blocked.test',{body});await Bun.sleep(5);
 const abort=new AbortController();const cancelled=pacer.fetch('https://blocked.test',{body,signal:abort.signal});
 const rejection=cancelled.catch(error=>error);abort.abort();expect(await rejection).toMatchObject({name:'AbortError'});
 await pacer.fetch('https://independent.test',{body});release();await first;
 expect(calls).toBe(2);expect(peak).toBe(2);
});
test('signed sends are attempted once even when provider returns 429',async()=>{
 let calls=0;const pacer=createRpcPacer({retryOn429:{attempts:4}},(async()=>{calls++;return new Response('',{status:429});}) as unknown as FetchFn);
 const response=await pacer.fetch('https://signed.test',{body:JSON.stringify([{method:'getSlot'},{method:'sendTransaction',params:['signed-bytes']}])});
 expect(response.status).toBe(429);expect(calls).toBe(1);
});
test('two core connections can share the same pacer and injected transport',async()=>{
 const starts:number[]=[];
 const rpc=createRpcPacer({maxRps:2},(async(_input:Parameters<FetchFn>[0],init?:Parameters<FetchFn>[1])=>{
  starts.push(Date.now());const request=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:123}));
 }) as unknown as FetchFn);
 const a=new SolardConnection('https://core-pacer.test','confirmed',{rpc}).get();
 const b=new SolardConnection('https://core-pacer.test','confirmed',{rpc}).get();
 const rawHistory=solardConnectionFetch(a,'https://core-pacer.test',{method:'POST',body}).then(response=>response.json()).then(result=>result.result);
 expect(await Promise.all([a.getSlot(),b.getSlot(),a.getSlot(),rawHistory])).toEqual([123,123,123,123]);
 expect(starts[2]!-starts[0]!).toBeGreaterThanOrEqual(1000);
});
