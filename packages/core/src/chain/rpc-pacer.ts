import type {FetchFn} from '@solana/web3.js';
import {createSolardMeasure} from '../core/log.ts';
import {measured} from '../core/measured.ts';
import {traceSolardRpcRequest,traceSolardRpcHttp,markSolardRpcQueued} from './rpc-observer.ts';
const measure=createSolardMeasure('rpc-pacer');
export type RpcPacingOptions={
 maxRps?:number;
 maxConcurrent?:number;
 retryOn429?:{attempts?:number;honorRetryAfter?:boolean;};
};
type Start={at:number};
type Ticket={start:(slot:Start)=>void;reject:(error:unknown)=>void;signal?:AbortSignal|null;cancel:()=>void};
type Endpoint={starts:Start[];active:number;pausedUntil:number;queue:Ticket[];timer?:ReturnType<typeof setTimeout>};
const aborted=()=>new DOMException('RPC request cancelled','AbortError');
function integer(value:number,floor:number,name:string){if(!Number.isSafeInteger(value)||value<floor)throw Error(`Invalid RPC ${name}`);return value;}
/** Share this instance across clients to share endpoint budgets. No global fetch patch. */
export class RpcPacer{
 private endpoints=new Map<string,Endpoint>();
 private maxRps:number;private maxConcurrent:number;private attempts:number;private honorRetryAfter:boolean;
 constructor(options:RpcPacingOptions={},private transport:FetchFn=((input,init)=>globalThis.fetch(input,init)) as FetchFn){
  this.maxRps=integer(options.maxRps??4,1,'maxRps');
  this.maxConcurrent=integer(options.maxConcurrent??8,1,'maxConcurrent');
  this.attempts=integer(options.retryOn429?.attempts??4,0,'429 attempts');
  this.honorRetryAfter=options.retryOn429?.honorRetryAfter!==false;
 }
 private pump(endpoint:Endpoint){
  if(endpoint.timer)clearTimeout(endpoint.timer);endpoint.timer=undefined;
  const now=performance.now();endpoint.starts=endpoint.starts.filter(start=>start.at>now-1000).sort((a,b)=>a.at-b.at);
  while(endpoint.queue.length&&endpoint.active<this.maxConcurrent){
   const delay=Math.max(endpoint.pausedUntil-now,endpoint.starts.length>=this.maxRps?endpoint.starts[0]!.at+1000-now:0);
   if(delay>0){if(Number.isFinite(delay))endpoint.timer=setTimeout(()=>this.pump(endpoint),Math.ceil(delay));return;}
   const ticket=endpoint.queue.shift()!;
   ticket.signal?.removeEventListener('abort',ticket.cancel);
   if(ticket.signal?.aborted){ticket.reject(aborted());continue;}
   // Admission is reserved until dispatch, even if logging/observers delay it.
   endpoint.active++;const slot={at:Infinity};endpoint.starts.push(slot);ticket.start(slot);
  }
 }
 private acquire(endpoint:Endpoint,signal?:AbortSignal|null):Promise<Start>{
  if(signal?.aborted)return Promise.reject(aborted());
  if(endpoint.queue.length>=512)return Promise.reject(Object.assign(new Error('RPC_QUEUE_FULL'),{code:'RPC_QUEUE_FULL'}));
  return new Promise((resolve,reject)=>{
   const ticket:Ticket={start:resolve,reject,signal,cancel:()=>{
    const index=endpoint.queue.indexOf(ticket);if(index>=0)endpoint.queue.splice(index,1);
    signal?.removeEventListener('abort',ticket.cancel);reject(aborted());this.pump(endpoint);
   }};
   signal?.addEventListener('abort',ticket.cancel,{once:true});endpoint.queue.push(ticket);this.pump(endpoint);
  });
 }
 readonly fetch=((input,init)=>traceSolardRpcRequest(input,init,()=>this.run(input,init))) as FetchFn;
 private async run(input:Parameters<FetchFn>[0],init?:Parameters<FetchFn>[1]):Promise<Response>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).toString();
  let endpoint=this.endpoints.get(url);if(!endpoint){endpoint={starts:[],active:0,pausedUntil:0,queue:[]};this.endpoints.set(url,endpoint);}
  const signal=init?.signal??(typeof input==='object'&&'signal' in input?input.signal:undefined);
  let retryable=false;
  // Never replay signed sends, mixed batches, opaque bodies or one-shot Requests.
  try{const body=typeof init?.body==='string'?JSON.parse(init.body):null;const rows=Array.isArray(body)?body:[body];
   retryable=rows.length>0&&rows.every(row=>row&&typeof row.method==='string'&&row.method!=='sendTransaction')&&!(input instanceof Request);
  }catch{}
  for(let attempt=0;;attempt++){
   markSolardRpcQueued();
   const slot=await measured(measure,'endpoint queue',()=>this.acquire(endpoint!,signal),()=>undefined);
   let response:Awaited<ReturnType<FetchFn>>;
   try{
    if(signal?.aborted)throw aborted();
    response=await traceSolardRpcHttp(input,init,()=>{
     try{return this.transport(input,init);}
     // Stamp after invocation: never expire a rate slot before its actual start.
     finally{slot.at=performance.now();this.pump(endpoint!);}
    });
    if(response.status===429){
     let delay=Math.min(300_000,1000*2**Math.min(attempt,9));
     const header=this.honorRetryAfter?response.headers.get('retry-after'):null;
     if(header){const seconds=Number(header);const explicit=Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now();if(Number.isFinite(explicit)&&explicit>=0)delay=explicit;}
     endpoint.pausedUntil=Math.max(endpoint.pausedUntil,performance.now()+delay);
    }
   }finally{if(slot.at===Infinity)endpoint.starts=endpoint.starts.filter(start=>start!==slot);endpoint.active--;this.pump(endpoint);}
   if(response.status!==429||!retryable||attempt>=this.attempts)return response;
   try{await response.body?.cancel();}catch{}
  }
 }
}
export function createRpcPacer(options:RpcPacingOptions={},fetch?:FetchFn){return new RpcPacer(options,fetch);}
const configured=new WeakMap<object,Map<FetchFn|undefined,RpcPacer>>();
let shared:RpcPacer|undefined;
export function resolveRpcPacer(rpc?:RpcPacingOptions|RpcPacer,fetch?:FetchFn):RpcPacer{
 if(rpc instanceof RpcPacer)return rpc;
 const key=rpc??fetch;
 if(!key)return shared??=createRpcPacer();
 let transports=configured.get(key);if(!transports){transports=new Map();configured.set(key,transports);}
 let pacer=transports.get(fetch);if(!pacer){pacer=createRpcPacer(rpc,fetch);transports.set(fetch,pacer);}return pacer;
}
