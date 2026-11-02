import {openRpcTraceStore} from './rpc-trace-store.ts';
import type {SolardRpcObservation} from '../chain/rpc-observer.ts';
let store:ReturnType<typeof openRpcTraceStore>|undefined,count=0;
self.onmessage=(event:MessageEvent)=>{
 const data=event.data as {path?:string;events?:SolardRpcObservation[];session:string;processId:number};
 try{store??=openRpcTraceStore(data.path!);if(data.events){store.write(data.events,data.session,data.processId);if(++count%50===0)store.prune();}self.postMessage({ok:true,written:data.events?.length??0});}
 catch{self.postMessage({ok:false,code:'TRACE_STORAGE_UNAVAILABLE'});}
};
