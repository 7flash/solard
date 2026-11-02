import {expect,spyOn,test} from 'bun:test';
import {Connection,type FetchFn} from '@solana/web3.js';
import {createRpcPacer} from '@solard/core';
import {subscribeTrades} from './live.ts';
test('live readiness and subscription HTTP use the injected shared pacer without global fetch',async()=>{
 const originalSocket=globalThis.WebSocket;
 const methods:string[]=[];
 const rpc=createRpcPacer({maxRps:100},(async(_url:Parameters<FetchFn>[0],init?:Parameters<FetchFn>[1])=>{
  const request=JSON.parse(String(init?.body));methods.push(request.method);
  const result=request.method==='getGenesisHash'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':request.method==='getSlot'?123:{context:{slot:123},value:0};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 }) as unknown as FetchFn);
 globalThis.WebSocket=class extends EventTarget{
  constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(payload:string){const request=JSON.parse(payload);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:request.id,result:42})})));}
  close(){}
 } as unknown as typeof WebSocket;
 let connection:Connection|undefined;
 const logs=spyOn(Connection.prototype,'onLogs').mockImplementation(function(this:Connection){connection=this;return 1;});
 const remove=spyOn(Connection.prototype,'removeOnLogsListener').mockResolvedValue(undefined);
 const globalFetch=spyOn(globalThis,'fetch').mockImplementation((async()=>{throw Error('Unpaced global HTTP request');}) as unknown as typeof fetch);
 let subscription:Awaited<ReturnType<typeof subscribeTrades>>|undefined;
 try{
  subscription=await subscribeTrades({ source: "rpc",rpc,rpcUrls:['https://injected-live.test'],tokens:['So11111111111111111111111111111111111111112'],onTrade(){}});
  expect(await connection!.getSlot()).toBe(123);
  expect(methods).toContain('getGenesisHash');expect(methods).toContain('getBalance');expect(methods).toContain('getSlot');
  expect(globalFetch).not.toHaveBeenCalled();
 }finally{await subscription?.close();logs.mockRestore();remove.mockRestore();globalFetch.mockRestore();globalThis.WebSocket=originalSocket;}
});
