import {AsyncLocalStorage} from 'async_hooks';

export type SolardRpcContext={wallet?:string;mint?:string;stage?:string};
export type SolardRpcObservation=Readonly<{
 id:string;parentId:string|null;kind:'rpc'|'request'|'http';phase:'queued'|'network'|'completed'|'failed';
 method:string;requestCount:number;endpoint:string;startedAtMs:number;updatedAtMs:number;durationMs:number;
 httpStatus:number|null;errorCode:string|null;context:Readonly<SolardRpcContext>;
}>;
type Listener=(event:SolardRpcObservation)=>void|Promise<void>;
type Frame={context:SolardRpcContext;requestId?:string;requestEvent?:SolardRpcObservation};
const local=new AsyncLocalStorage<Frame>(),listeners=new Set<Listener>();
function runFrame<T>(frame:Frame,operation:()=>T):T{let result!:T;local.run(frame,()=>{result=operation();});return result;}
export function observeSolardRpc(listener:Listener):()=>void{listeners.add(listener);return ()=>{listeners.delete(listener);};}
export function withSolardRpcContext<T>(context:SolardRpcContext,operation:()=>T):T{
 const safe:SolardRpcContext={};
 for(const key of ['wallet','mint','stage'] as const){const value=context[key];if(typeof value==='string'&&value.length<=160&&!value.includes('://')&&/^[A-Za-z0-9 .:_/-]+$/.test(value))safe[key]=value;}
 return runFrame({...local.getStore(),context:{...local.getStore()?.context,...safe}},operation);
}
export function markSolardRpcQueued(){const event=local.getStore()?.requestEvent;if(event)notify({...event,phase:'queued',updatedAtMs:Date.now(),durationMs:Math.max(0,Date.now()-event.startedAtMs)});}
function endpoint(input:RequestInfo|URL){try{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);return `${u.protocol}//${u.host}/***`;}catch{return '<invalid endpoint>';}}
function methods(body:unknown){
 try{const parsed=typeof body==='string'?JSON.parse(body):null,rows=Array.isArray(parsed)?parsed:[parsed];
  const names=[...new Set(rows.map(r=>typeof r?.method==='string'&&/^[a-zA-Z0-9_]{1,80}$/.test(r.method)?r.method:'request'))];
  return {method:names.join(',').slice(0,250),requestCount:rows.length};
 }catch{return {method:'request',requestCount:1};}
}
function notify(event:SolardRpcObservation){
 const frozen=Object.freeze({...event,context:Object.freeze({...event.context})});
 for(const listener of [...listeners])try{const result=listener(frozen);if(result&&typeof result.catch==='function')result.catch(()=>{});}catch{}
}
function code(error:unknown){const value=(error as {code?:unknown})?.code;return typeof value==='string'&&/^(?:RPC_[A-Z_]+|HTTP_\d{3}|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_[A-Z_]+)$/.test(value)?value:(error as Error)?.name==='AbortError'?'ABORTED':'NETWORK_ERROR';}
async function trace(input:RequestInfo|URL,init:RequestInit|undefined,kind:'request'|'http',operation:()=>Promise<Response>):Promise<Response>{
 if(!listeners.size)return await operation();
 const parent=local.getStore();
 if(kind==='request'&&parent?.requestId)return await operation();
 if(kind==='http'&&parent?.requestEvent)notify({...parent.requestEvent,phase:'network',updatedAtMs:Date.now(),durationMs:Math.max(0,Date.now()-parent.requestEvent.startedAtMs)});
 const startedAtMs=Date.now(),clock=performance.now(),id=crypto.randomUUID();
 const event:SolardRpcObservation={id,parentId:kind==='http'?parent?.requestId??null:null,kind,phase:kind==='request'?'queued':'network',...methods(init?.body),endpoint:endpoint(input),startedAtMs,updatedAtMs:startedAtMs,durationMs:0,httpStatus:null,errorCode:null,context:parent?.context??{}};
 notify(event);
 return await runFrame({context:event.context,requestId:kind==='request'?id:parent?.requestId,requestEvent:kind==='request'?event:parent?.requestEvent},async()=>{
  try{const response=await operation();notify({...event,phase:'completed',updatedAtMs:Date.now(),durationMs:performance.now()-clock,httpStatus:response.status,errorCode:response.ok?null:`HTTP_${response.status}`});return response;}
  catch(error){notify({...event,phase:'failed',updatedAtMs:Date.now(),durationMs:performance.now()-clock,errorCode:code(error)});throw error;}
 });
}
/** Queue/total transport lifecycle; nested pool/transport wrappers remain one logical request. */
export function traceSolardRpcRequest(input:RequestInfo|URL,init:RequestInit|undefined,operation:()=>Promise<Response>){return trace(input,init,'request',operation);}
/** One physical HTTP attempt. Durations end at response headers, without consuming the body. */
export function traceSolardRpcHttp(input:RequestInfo|URL,init:RequestInit|undefined,operation:()=>Promise<Response>){return trace(input,init,'http',operation);}
/** Observe an existing fetch policy without adding retries, gates or reading its response body. */
export function observedSolardRpcFetch(input:RequestInfo|URL,init?:RequestInit){return traceSolardRpcRequest(input,init,()=>traceSolardRpcHttp(input,init,()=>globalThis.fetch(input,init)));}
/** Complete web3.js RPC lifecycle, including consuming/decoding the JSON response. */
export async function traceSolardRpcOperation<T>(input:RequestInfo|URL,method:string|Array<{method:string}>,operation:()=>Promise<T>):Promise<T>{
 if(!listeners.size||local.getStore()?.requestId)return await operation();
 const clock=performance.now(),startedAtMs=Date.now(),id=crypto.randomUUID();
 const event:SolardRpcObservation={id,parentId:null,kind:'rpc',phase:'queued',...methods(JSON.stringify(typeof method==='string'?{method}:method)),endpoint:endpoint(input),startedAtMs,updatedAtMs:startedAtMs,durationMs:0,httpStatus:null,errorCode:null,context:local.getStore()?.context??{}};
 notify(event);return await runFrame({context:event.context,requestId:id,requestEvent:event},async()=>{
  try{const result=await operation(),values=Array.isArray(result)?result:[result],error=values.find(value=>value&&typeof value==='object'&&'error' in value)?.error;
   const errorCode=error?(Number.isSafeInteger(error.code)?`RPC_${error.code}`:'RPC_ERROR'):null;
   notify({...event,phase:errorCode?'failed':'completed',updatedAtMs:Date.now(),durationMs:performance.now()-clock,errorCode});return result;
  }catch(error){notify({...event,phase:'failed',updatedAtMs:Date.now(),durationMs:performance.now()-clock,errorCode:code(error)});throw error;}
 });
}
