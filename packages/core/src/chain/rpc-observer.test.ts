import {test,expect,spyOn} from 'bun:test';
import {observeSolardRpc,withSolardRpcContext,type SolardRpcObservation} from './rpc-observer.ts';
import {solardRpcFetch,SolardRpcEndpointPool,SolardConnection} from './connection.ts';
test('global RPC observer captures queue and physical HTTP timing without credentials or signed bytes',async()=>{
 const events:SolardRpcObservation[]=[],stop=observeSolardRpc(e=>{events.push(e);});
 const mock=mockFetch(async()=>{await Bun.sleep(8);return new Response('{"result":"ok"}');});
 try{
  await withSolardRpcContext({wallet:'wallet-a',mint:'mint-a',stage:'prepare'},()=>solardRpcFetch('https://user:password@rpc.example/secret-path?api-key=secret',{method:'POST',body:JSON.stringify({method:'sendTransaction',params:['SIGNED_BYTES_SECRET']})}));
  const request=events[0]!,http=events.find(e=>e.kind==='http'&&e.phase==='network')!;expect(http.parentId).toBe(request.id);expect(http.context.stage).toBe('prepare');
  expect(events.some(e=>e.kind==='request'&&e.phase==='network')).toBe(true);
  const done=events.find(e=>e.kind==='http'&&e.phase==='completed')!,total=events.at(-1)!;
  expect(done.durationMs).toBeGreaterThanOrEqual(7);expect(total.durationMs).toBeGreaterThanOrEqual(done.durationMs);
  const serialized=JSON.stringify(events);for(const secret of ['password','secret-path','api-key','SIGNED_BYTES_SECRET'])expect(serialized).not.toContain(secret);
 }finally{mock.mockRestore();stop();}
});
test('observer errors never alter a failed send or create a retry',async()=>{
 const events:SolardRpcObservation[]=[],stop=observeSolardRpc(e=>{events.push(e);}),broken=observeSolardRpc(()=>{throw Error('sink unavailable');});
 let calls=0;const error=Object.assign(Error('secret-url'),{code:'ECONNRESET'});
 const mock=mockFetch(async()=>{calls++;throw error;});
 try{await expect(solardRpcFetch('https://rpc.example',{method:'POST',body:'{"method":"sendTransaction"}'})).rejects.toBe(error);expect(calls).toBe(1);expect(events.at(-1)?.phase).toBe('failed');expect(JSON.stringify(events)).not.toContain('secret-url');}
 finally{mock.mockRestore();broken();stop();}
});
test('pool and transport report one logical request with physical attempts beneath it',async()=>{
 const events:SolardRpcObservation[]=[],stop=observeSolardRpc(e=>{events.push(e);});
 const mock=mockFetch(async()=>new Response('{"result":1}'));
  try{await new SolardRpcEndpointPool(['https://observer.example']).fetch('https://observer.example',{method:'POST',body:'{"method":"getBalance"}'});expect(new Set(events.filter(e=>e.kind==='request').map(e=>e.id)).size).toBe(1);expect(events.filter(e=>e.kind==='http'&&e.phase==='network')).toHaveLength(1);}
 finally{mock.mockRestore();stop();}
});
test('standard connection RPC timing includes delayed response body decoding',async()=>{
 const events:SolardRpcObservation[]=[],stop=observeSolardRpc(e=>{events.push(e);});
 const mock=mockFetch(async(_input,init)=>{
  const {id}=JSON.parse(String(init?.body));return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id,result:123})));controller.close();},45);}}),{headers:{'content-type':'application/json'}});
 });
 try{expect(await new SolardConnection('https://body.example').get().getSlot()).toBe(123);
  const rpc=events.find(e=>e.kind==='rpc'&&e.phase==='completed')!,http=events.find(e=>e.kind==='http'&&e.phase==='completed')!;
  expect(rpc.durationMs).toBeGreaterThanOrEqual(40);expect(http.durationMs).toBeLessThan(rpc.durationMs);expect(http.parentId).toBe(rpc.id);
 }finally{mock.mockRestore();stop();}
});

function mockFetch(fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) { return spyOn(globalThis, 'fetch').mockImplementation(fn as typeof fetch); }
