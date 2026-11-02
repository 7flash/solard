import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'fs';
import * as fs from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {fileURLToPath} from 'url';
import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {Solard} from '../../core/src/core/solard.ts';
// The repository's legacy fs declarations omit this supported Bun/Node API.
const rmSync=Reflect.get(fs,'rmSync') as (path:string,options:{recursive:boolean;force:boolean})=>void;

for(const rejectPrimary of [false,true])test(`one-shot transfer prints CONFIRMED then PERF and exits naturally (${rejectPrimary?'429 HTTP/WS fallback':'healthy HTTP/WS'})`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'slrd-cli-exit-'));
 const dbPath=join(directory,'wallets.sqlite'),configPath=join(directory,'rpc.json');
 const oldKey=process.env.SLRD_MASTER_KEY;
 process.env.SLRD_MASTER_KEY='local-mock-cli-exit-test-only';
 const core=new Solard({dbPath});
 const payer=core.createWallet('mock-payer');core.close();
 if(oldKey===undefined)delete process.env.SLRD_MASTER_KEY;else process.env.SLRD_MASTER_KEY=oldKey;
 let wsAttempts=0,sendCount=0;
 let websocketSeen!:()=>void;
 const wsSeen=new Promise<void>(resolve=>{websocketSeen=resolve;});
 const methods:string[]=[];
 const account={lamports:1_000_000_000,owner:PublicKey.default.toBase58(),data:['','base64'],executable:false,rentEpoch:0};
 async function reply(request:Request){
  const body=await request.json() as {id:unknown;method:string;params:any[]};
  methods.push(body.method);
  const context={slot:123};let result:unknown;
  switch(body.method){
   case 'getGenesisHash':result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';break;
   case 'getAccountInfo':result={context,value:account};break;
   case 'getMultipleAccounts':result={context,value:body.params[0].map(()=>account)};break;
   case 'getBalance':result={context,value:account.lamports};break;
   case 'getLatestBlockhash':result={context,value:{blockhash:PublicKey.default.toBase58(),lastValidBlockHeight:1000}};break;
   case 'getBlockHeight':case 'getSlot':result=123;break;
   case 'getRecentPrioritizationFees':result=[{slot:123,prioritizationFee:100000}];break;
   case 'getFeeForMessage':result={context,value:6000};break;
   case 'simulateTransaction':result={context,value:{err:null,logs:[],unitsConsumed:9000,accounts:body.params[1]?.accounts?.addresses?.map(()=>account)??null,returnData:null}};break;
   case 'sendTransaction':sendCount++;result=bs58.encode(VersionedTransaction.deserialize(Buffer.from(body.params[0],'base64')).signatures[0]!);break;
   case 'getSignatureStatuses':
    await wsSeen;await Bun.sleep(30);
    result={context,value:body.params[0].map(()=>({slot:123,confirmations:1,err:null,confirmationStatus:'confirmed'}))};break;
   case 'getTransaction':result=null;break;
   default:return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:`Unexpected mock method ${body.method}`}});
  }
  return Response.json({jsonrpc:'2.0',id:body.id,result});
 }
 const primary=Bun.serve({hostname:'127.0.0.1',port:0,fetch:rejectPrimary?()=>new Response('quota',{status:429}):reply});
 const ws=Bun.serve({hostname:'127.0.0.1',port:primary.port!+1,
  fetch(request,server){wsAttempts++;websocketSeen();if(rejectPrimary)return new Response('quota',{status:429});if(server.upgrade(request))return;return new Response('upgrade required',{status:400});},
  websocket:{message(socket,message){const data=JSON.parse(String(message));socket.send(JSON.stringify({jsonrpc:'2.0',id:data.id,result:1}));if(data.method==='signatureSubscribe')socket.send(JSON.stringify({jsonrpc:'2.0',method:'signatureNotification',params:{subscription:1,result:{context:{slot:123},value:{err:null}}}}));}},
 });
 const backup=Bun.serve({hostname:'127.0.0.1',port:0,fetch:reply});
 writeFileSync(configPath,JSON.stringify({version:1,auto:true,http:[primary,backup].map(server=>({url:server.url.href,group:`mock-${server.port}`,rps:1000,concurrency:8})),websocket:[],aggregateRps:1000}));
 let timer:ReturnType<typeof setTimeout>|undefined;
 const child=Bun.spawn([process.execPath,fileURLToPath(new URL('../bin/solard.ts',import.meta.url)),'transfer',PublicKey.default.toBase58(),'--wallet',payer.address,'--sol','0.001','--sender','rpc'],{
  stdout:'pipe',stderr:'pipe',env:{...process.env,SLRD_MASTER_KEY:'local-mock-cli-exit-test-only',SLRD_DB_PATH:dbPath,SOLARD_DB_PATH:dbPath,SLRD_RPC_CONFIG_PATH:configPath,RPC_ENDPOINT:primary.url.href,SLRD_RPC_URLS:JSON.stringify([primary.url.href,backup.url.href]),SLRD_WS_URLS:'[]',SLRD_RPC_GATE_DB:'',SLRD_RPC_MAX_RPS:'1000',SLRD_RPC_WINDOW_MS:'1',SLRD_RPC_SEND_WINDOW_MS:'1',SOLARD_TRANSACTION_VERSION:'0'},
 });
 try{
  const code=await Promise.race([child.exited,new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),7000);})]);
  if(code==='timeout')child.kill();await child.exited;
  const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
  if(code!==0)throw Error(`Child ${code}; methods=${methods.join(',')}; stdout=${stdout}; stderr=${stderr}`);
  expect(stdout).toContain('"code": "CONFIRMED"');
  expect(stdout.match(/PERF\s+wall=/g)).toHaveLength(1);
  expect(stdout.indexOf('PERF')).toBeGreaterThan(stdout.indexOf('CONFIRMED'));
  expect(sendCount).toBe(1);expect(wsAttempts).toBeGreaterThan(0);
 }finally{
  if(timer)clearTimeout(timer);child.kill();primary.stop(true);ws.stop(true);backup.stop(true);
  rmSync(directory,{recursive:true,force:true});
 }
},12000);
