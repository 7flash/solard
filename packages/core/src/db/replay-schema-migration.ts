import {Database as SqliteDatabase} from 'bun:sqlite';
import {Database as OrmDatabase} from 'sqlite-zod-orm';
import {HistoryReplayItemSchema,HistoryReplayCoverageSchema} from './schema.ts';

const schemas={historyReplayItems:HistoryReplayItemSchema,historyReplayCoverage:HistoryReplayCoverageSchema};
const defaults:Record<string,string|number|null>={eventId:'',effectOrdinal:0,payoutAssetMint:null,payoutAttribution:null,attemptedThroughSlot:0,fromCreation:0,discoveryComplete:0,fetchComplete:0,parsingComplete:0,orderingComplete:0,attributionComplete:0,contextJson:'{"recipient":null,"originalCreator":null}'};
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const normalize=(sql:string)=>sql.replace(/\s+/g,' ').trim().replace(/;$/,'');
let expected:Map<string,string>|undefined;
function expectedTables(){
 if(expected)return expected;
 const template=new OrmDatabase(':memory:',schemas,{timestamps:false,softDeletes:false,unique:{historyReplayItems:[['replayKey']],historyReplayCoverage:[['mint']]}});
 try{expected=new Map((template.raw("SELECT name,sql FROM sqlite_master WHERE type='table'") as Array<{name:string;sql:string}>).filter(row=>row.name in schemas).map(row=>[row.name,row.sql]));return expected;}finally{template.close();}
}

/** Normalize only replay tables before ORM sync. Keep the original as a backup,
 * copy every declared value, and preserve current indexes/triggers atomically.
 * Never merge or delete historical backups automatically.
 */
export function migrateReplaySchemas(path:string){
 const expected=expectedTables(),db=new SqliteDatabase(path);
 try{db.exec('PRAGMA busy_timeout = 5000');db.exec('PRAGMA legacy_alter_table = ON');
  db.transaction(()=>{for(const [table,sql]of expected){
   const current=db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string}|null;
   if(!current||normalize(current.sql)===normalize(sql))continue;
   const columns=(db.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{name:string}>).map(c=>c.name);
   const schema=schemas[table as keyof typeof schemas],target=['id',...Object.keys(schema.shape)];
   const unknown=columns.filter(c=>!target.includes(c));if(unknown.length)throw Error(`Replay migration refuses undeclared columns in ${table}`);
   let version=1;while(db.query('SELECT 1 FROM sqlite_master WHERE name=?').get(`${table}_v${version}`))version++;
   const backup=`${table}_v${version}`;
   const objects=db.query("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table) as Array<{type:string;name:string;sql:string}>;
   for(const object of objects)db.exec(`DROP ${object.type==='index'?'INDEX':'TRIGGER'} ${quote(object.name)}`);
   db.exec(`ALTER TABLE ${quote(table)} RENAME TO ${quote(backup)}`);db.exec(sql);
   const values:unknown[]=[];
   const expressions=target.map(c=>{if(columns.includes(c))return quote(c);if(c in defaults){values.push(defaults[c]);return '?';}return 'NULL';});
   db.query(`INSERT INTO ${quote(table)} (${target.map(quote).join(',')}) SELECT ${expressions.join(',')} FROM ${quote(backup)}`).run(...values as any[]);
   const count=(name:string)=>(db.query(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as {n:number}).n;
   if(count(table)!==count(backup))throw Error('Replay migration row count mismatch');
   for(const object of objects)db.exec(object.sql);
  }})();
 }finally{db.close();}
}
