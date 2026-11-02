import {test,expect,spyOn} from 'bun:test';
import {Database as OrmDatabase} from 'sqlite-zod-orm';
import {Database as SqliteDatabase} from 'bun:sqlite';
import {mkdtempSync,rmdirSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {HistoryReplayItemSchema,HistoryReplayCoverageSchema} from './schema.ts';
import {openDatabase,closeDatabase} from './database.ts';

test('legacy raw-added replay values survive migration and two unchanged full database opens',()=>{
 const dir=mkdtempSync(join(tmpdir(),'solard-replay-reopen-')),path=join(dir,'db.sqlite');
 try{
  const legacy=new OrmDatabase(path,{
   historyReplayItems:HistoryReplayItemSchema.omit({eventId:true,effectOrdinal:true,payoutAssetMint:true,payoutAttribution:true}),
   historyReplayCoverage:HistoryReplayCoverageSchema.omit({fromCreation:true,discoveryComplete:true,fetchComplete:true,parsingComplete:true,orderingComplete:true,attributionComplete:true,contextJson:true}),
  },{timestamps:false,softDeletes:false,unique:{historyReplayItems:[['replayKey']],historyReplayCoverage:[['mint']]}});
  legacy.historyReplayItems.insert({replayKey:'r',mint:'mint',signature:'sig',slot:7,kind:'claim',trxJson:'{}',parserVersion:'v1',observedAtMs:1,updatedAtMs:1});
  legacy.historyReplayCoverage.insert({mint:'mint',parserVersion:'v1',finalizedThroughSlot:7,updatedAtMs:1});legacy.close();
  // Reproduce the former maintenance layout and populated fields exactly.
  const raw=new SqliteDatabase(path);
  for(const c of ["eventId TEXT NOT NULL DEFAULT ''","effectOrdinal INTEGER NOT NULL DEFAULT 0","payoutAssetMint TEXT","payoutAttribution TEXT"])raw.exec(`ALTER TABLE historyReplayItems ADD COLUMN ${c}`);
  for(const c of ['fromCreation','discoveryComplete','fetchComplete','parsingComplete','orderingComplete','attributionComplete'])raw.exec(`ALTER TABLE historyReplayCoverage ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  raw.exec(`ALTER TABLE historyReplayCoverage ADD COLUMN contextJson TEXT NOT NULL DEFAULT '{"recipient":null,"originalCreator":null}'`);
  raw.exec(`UPDATE historyReplayItems SET eventId='event-7',effectOrdinal=3,payoutAssetMint='USDC',payoutAttribution='exact-token'; UPDATE historyReplayCoverage SET attemptedThroughSlot=9,fromCreation=1,discoveryComplete=1,fetchComplete=1,parsingComplete=1,orderingComplete=1,attributionComplete=1,contextJson='{"recipient":"alice","originalCreator":"bob"}'`);raw.close();
  const hooks=new SqliteDatabase(path);hooks.exec(`CREATE TABLE replay_audit(eventId TEXT); CREATE INDEX replay_event_idx ON historyReplayItems(eventId); CREATE TRIGGER replay_audit_trigger AFTER UPDATE ON historyReplayItems BEGIN INSERT INTO replay_audit VALUES(NEW.eventId); END;`);hooks.close();
  let db=openDatabase(path);expect(db.historyReplayItems.select().first()?.eventId).toBe('event-7');closeDatabase(path);
  const backups=()=>{const d=new SqliteDatabase(path);try{return d.query("SELECT name FROM sqlite_master WHERE name GLOB 'historyReplay*_v[0-9]*' ORDER BY name").all();}finally{d.close();}};
  const before=backups(),messages:string[]=[],log=spyOn(console,'log').mockImplementation((...args)=>{messages.push(args.join(' '));});
  try{for(let i=0;i<2;i++){
   db=openDatabase(path);
   try{const item=db.historyReplayItems.select().first()!,coverage=db.historyReplayCoverage.select().first()!;
    expect([item.id,item.eventId,item.effectOrdinal,item.payoutAssetMint,item.payoutAttribution]).toEqual([1,'event-7',3,'USDC','exact-token']);
    expect([coverage.attemptedThroughSlot,coverage.fromCreation,coverage.discoveryComplete,coverage.fetchComplete,coverage.parsingComplete,coverage.orderingComplete,coverage.attributionComplete]).toEqual([9,1,1,1,1,1,1]);
    expect(JSON.parse(coverage.contextJson)).toEqual({recipient:'alice',originalCreator:'bob'});
   }finally{closeDatabase(path);}
   expect(backups()).toEqual(before);
  }expect(messages.some(m=>/Rebuilt.*historyReplay/.test(m))).toBe(false);}finally{log.mockRestore();}
  const verify=new SqliteDatabase(path);try{verify.exec(`UPDATE historyReplayItems SET eventId='event-after'`);
   expect(verify.query('SELECT eventId FROM replay_audit').all()).toEqual([{eventId:'event-after'}]);
   expect(verify.query("SELECT tbl_name FROM sqlite_master WHERE name='replay_event_idx'").get()).toEqual({tbl_name:'historyReplayItems'});
  }finally{verify.close();}
 }finally{closeDatabase(path);rmdirSync(dir,{recursive:true});}
});
