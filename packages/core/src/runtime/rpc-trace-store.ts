import {Database,z} from 'sqlite-zod-orm';
import {mkdirSync} from 'fs';
import {dirname} from 'path';
import type {SolardRpcObservation} from '../chain/rpc-observer.ts';
const RpcCall=z.object({eventId:z.string(),parentId:z.string().nullable(),session:z.string(),processId:z.number(),kind:z.string(),phase:z.string(),method:z.string(),requestCount:z.number(),endpoint:z.string(),startedAtMs:z.number(),updatedAtMs:z.number(),durationMs:z.number(),httpStatus:z.number().nullable(),errorCode:z.string().nullable(),wallet:z.string().nullable(),mint:z.string().nullable(),stage:z.string().nullable()});
export function openRpcTraceStore(path:string){
 mkdirSync(dirname(path),{recursive:true});
 const db=new Database(path,{rpcCalls:RpcCall},{timestamps:false,softDeletes:false,unique:{rpcCalls:[['eventId']]},indexes:{rpcCalls:['startedAtMs','phase','kind','session']}});
 db.raw('PRAGMA busy_timeout = 50');
 return {
  write(events:SolardRpcObservation[],session:string,processId:number){db.transaction(()=>{for(const e of events){
   const row={eventId:e.id,parentId:e.parentId,session,processId,kind:e.kind,phase:e.phase,method:e.method,requestCount:e.requestCount,endpoint:e.endpoint,startedAtMs:e.startedAtMs,updatedAtMs:e.updatedAtMs,durationMs:e.durationMs,httpStatus:e.httpStatus,errorCode:e.errorCode,wallet:e.context.wallet??null,mint:e.context.mint??null,stage:e.context.stage??null};
   db.rpcCalls.upsert({eventId:e.id},row);
  }});},
  read(limit=200){
   const bounded=Math.max(1,Math.min(500,Math.trunc(limit)));
   return {active:db.rpcCalls.select().where({phase:{$in:['queued','network']}}).orderBy('startedAtMs','desc').limit(200).all(),
    recent:db.rpcCalls.select().where({phase:{$in:['completed','failed']}}).orderBy('updatedAtMs','desc').limit(bounded).all()};
  },
  prune(retain=20000){const old=db.rpcCalls.select('id').where({phase:{$in:['completed','failed']}}).orderBy('startedAtMs','desc').offset(Math.max(100,retain)).limit(1000).all();if(old.length)db.rpcCalls.delete().where({id:{$in:old.map(r=>r.id)}}).exec();},
  close(){db.close();},
 };
}
