import {observeSolardRpc,type SolardRpcObservation} from '../chain/rpc-observer.ts';
import {mkdirSync,promises as fsAsync} from 'fs';
import {dirname,join} from 'path';
/** A bounded worker mailbox keeps SQLite latency and failures off the trading thread. */
export function recordSolardRpc(path:string){
 mkdirSync(dirname(path),{recursive:true});
 const session=crypto.randomUUID(),worker=new Worker(new URL('./rpc-trace-worker.ts',import.meta.url).href);
 const queue:SolardRpcObservation[]=[];let busy=false,closed=false,dropped=0,written=0,inFlight=0,error:string|null=null;
 const stop=observeSolardRpc(e=>{if(queue.length>=2000){queue.shift();dropped++;}queue.push(e);});
 worker.onmessage=(event:MessageEvent)=>{busy=false;written+=event.data.written??0;if(!event.data.ok)dropped+=inFlight;inFlight=0;error=event.data.ok?null:event.data.code;};
 worker.onerror=()=>{busy=false;dropped+=inFlight;inFlight=0;error='TRACE_WORKER_UNAVAILABLE';};
 const flush=setInterval(()=>{if(closed||busy||!queue.length)return;busy=true;const events=queue.splice(0,200);inFlight=events.length;try{worker.postMessage({path,session,processId:process.pid,events});}catch{dropped+=inFlight;inFlight=0;busy=false;error='TRACE_WORKER_UNAVAILABLE';}},100);
 const health=setInterval(()=>{void fsAsync.writeFile(join(dirname(path),'rpc-observer-health.json'),JSON.stringify({session,processId:process.pid,at:Date.now(),queued:queue.length,dropped,written,error})).catch(()=>{});},1000);
 return {async close(){stop();closed=true;clearInterval(flush);clearInterval(health);worker.terminate();}};
}
