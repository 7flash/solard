import {test,expect,spyOn} from 'bun:test';import {mkdtempSync,existsSync,readFileSync,rmdirSync} from 'fs';import {tmpdir} from 'os';import {join} from 'path';
import {recordSolardRpc} from './rpc-trace-recorder.ts';import {solardRpcFetch} from '../chain/connection.ts';import {openRpcTraceStore} from './rpc-trace-store.ts';
test('background recorder writes observed RPCs without running SQLite on the fetch callback',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rpc-recorder-')),path=join(root,'trace.sqlite'),record=recordSolardRpc(path),mock=mockFetch(async()=>new Response('{"result":1}'));
 try{await solardRpcFetch('https://trace.example/private?api-key=secret',{method:'POST',body:'{"method":"getBalance","params":["private-param"]}'});
  const health=join(root,'rpc-observer-health.json');let written=false;
  for(let i=0;i<100;i++){if(existsSync(health)){try{written=JSON.parse(readFileSync(health,'utf8')).written>=4;}catch{}if(written)break;}await Bun.sleep(30);}
  expect(written).toBe(true);await record.close();await Bun.sleep(30);
  const db=openRpcTraceStore(path);try{const rows=db.read();expect(rows.recent).toHaveLength(2);expect(JSON.stringify(rows)).not.toContain('private-param');expect(JSON.stringify(rows)).not.toContain('api-key');}finally{db.close();}
 }finally{mock.mockRestore();await record.close();await Bun.sleep(30);rmdirSync(root,{recursive:true});}
});

function mockFetch(fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) { return spyOn(globalThis, 'fetch').mockImplementation(fn as typeof fetch); }
