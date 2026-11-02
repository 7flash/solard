import {test,expect} from 'bun:test';
import {mkdtempSync,rmdirSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {openRpcTraceStore} from './rpc-trace-store.ts';
import type {SolardRpcObservation} from '../chain/rpc-observer.ts';
test('RPC observations persist active/completed lifecycle and reopen without duplicate rows',()=>{
 const root=mkdtempSync(join(tmpdir(),'solard-trace-')),path=join(root,'trace.sqlite');
 const event:SolardRpcObservation={id:'one',parentId:null,kind:'request',phase:'queued',method:'getBalance',requestCount:1,endpoint:'https://rpc.example/***',startedAtMs:1,updatedAtMs:1,durationMs:0,httpStatus:null,errorCode:null,context:{mint:'mint',stage:'price'}};
 try{let db=openRpcTraceStore(path);db.write([event],'session',1);expect(db.read().active).toHaveLength(1);
  db.write([{...event,phase:'completed',durationMs:42,updatedAtMs:43,httpStatus:200}],'session',1);
  expect(db.read().active).toHaveLength(0);db.close();db=openRpcTraceStore(path);
  try{expect(db.read().recent).toHaveLength(1);expect(db.read().recent[0]?.durationMs).toBe(42);expect(db.read().recent[0]?.mint).toBe('mint');}finally{db.close();}
 }finally{rmdirSync(root,{recursive:true});}
});
