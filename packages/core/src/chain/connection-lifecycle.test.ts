import {expect,test} from 'bun:test';
import type {FetchFn} from '@solana/web3.js';
import {SolardConnection} from './connection.ts';

test('closing an unused connection does not initialize RPC and is idempotent',()=>{
 const owner=new SolardConnection();
 owner.close();owner.close();
 expect(()=>owner.get()).toThrow('closed');
});

test('close aborts owned HTTP work without closing a different client',async()=>{
 let started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 let aborted=false;
 const first=new SolardConnection('https://cancel.example', 'confirmed', {rpc:{maxRps:1000,maxConcurrent:2,retryOn429:{attempts:0}},fetch:(async(...[_input,init]:Parameters<FetchFn>)=>{
  started();return await new Promise<Response>((_resolve,reject)=>{
   init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));},{once:true});
  });
 }) as FetchFn});
 const second=new SolardConnection('https://other.example','confirmed',{rpc:{maxRps:1000,maxConcurrent:2},fetch:(async(...[_input,init]:Parameters<FetchFn>)=>{
  const body=JSON.parse(String(init?.body));return Response.json({jsonrpc:'2.0',id:body.id,result:321});
 }) as FetchFn});
 try{
  const request=first.get().getSlot();
  // Attach rejection handling before closing the connection.
  const rejected=request.then(()=>null,error=>error);
  await ready;first.close();expect(await rejected).toBeInstanceOf(Error);
  expect(aborted).toBe(true);
  expect(await second.get().getSlot()).toBe(321);
 }finally{first.close();second.close();}
});

for(const outcome of ['confirmed','failed','submitted'] as const)test(`HTTP ${outcome} receipt exits naturally after primary HTTP and signature WebSocket 429`,async()=>{
 let websocketAttempts=0,primaryRequests=0,statusRequests=0;
 let rejected!:()=>void;
 const websocketRejected=new Promise<void>(resolve=>{rejected=resolve;});
 const primary=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){primaryRequests++;return new Response('quota',{status:429});}});
 const ws=Bun.serve({hostname:'127.0.0.1',port:primary.port!+1,fetch(){websocketAttempts++;rejected();return new Response('quota',{status:429});}});
 const backup=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const body=await request.json() as {id:unknown;method:string};
  if(body.method==='getSignatureStatuses'){
   statusRequests++;
   await websocketRejected;
   // Let the rejected upgrade schedule the reconnect before HTTP settles.
   await Bun.sleep(30);
  }
  return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='getSignatureStatuses'?{context:{slot:123},value:[outcome==='submitted'?null:{slot:123,confirmations:1,err:outcome==='failed'?{InstructionError:[0,{Custom:6003}]}:null,confirmationStatus:'confirmed'}]}:null});
 }});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const child=Bun.spawn([process.execPath,`${import.meta.dir}/fixtures/confirm-and-close.ts`,primary.url.href,backup.url.href],{stdout:'pipe',stderr:'pipe',env:{...process.env,FIXTURE_CONFIRM_TIMEOUT_MS:outcome==='submitted'?'200':'2000',SLRD_RPC_URLS:'[]',SLRD_RPC_VERIFY_MAINNET:'0',SLRD_RPC_MAX_RPS:'1000',SLRD_RPC_WINDOW_MS:'1',SLRD_RPC_SEND_WINDOW_MS:'1'}});
 try{
  const timeout=new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),4000);});
  const code=await Promise.race([child.exited,timeout]);
  if(code==='timeout')child.kill();
  await child.exited;
  const stdout=await new Response(child.stdout).text();
  const stderr=await new Response(child.stderr).text();
  if(code===1)throw new Error(stderr);
  expect(stdout).toContain(`"status":"${outcome}"`);
  expect(primaryRequests).toBeGreaterThan(0);
  expect(websocketAttempts).toBeGreaterThan(0);
  expect(statusRequests).toBe(outcome==='submitted'?2:1);
  expect(code).toBe(0);
 }finally{
  if(timer)clearTimeout(timer);
  child.kill();primary.stop(true);ws.stop(true);backup.stop(true);
 }
},10000);
