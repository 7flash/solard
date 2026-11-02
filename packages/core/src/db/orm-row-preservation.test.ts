import {test,expect} from 'bun:test';
import {Database as Sqlite} from 'bun:sqlite';
import {Database,z} from 'sqlite-zod-orm';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('nullable numeric schema migration preserves rows, ids and action references across reopens',()=>{
 const dir=mkdtempSync(join(tmpdir(),'solard-orm-preserve-')),path=join(dir,'db.sqlite');
 try{
 const raw=new Sqlite(path);raw.exec(`CREATE TABLE executions(id INTEGER PRIMARY KEY AUTOINCREMENT,signature TEXT,slot TEXT); INSERT INTO executions VALUES(40009,'retained-sweep','123'); CREATE TABLE executionActions(id INTEGER PRIMARY KEY,executionId INTEGER); INSERT INTO executionActions VALUES(1,40009)`);raw.close();
 for(let i=0;i<2;i++){
 const db=new Database(path,{executions:z.object({signature:z.string(),slot:z.number().nullable().default(null)})},{timestamps:false,softDeletes:false});
 expect(db.executions.select().first()).toMatchObject({id:40009,signature:'retained-sweep',slot:123});db.close();
 }
 const check=new Sqlite(path);try{expect(check.query('SELECT count(*) n FROM executionActions a JOIN executions e ON e.id=a.executionId').get()).toEqual({n:1});expect(check.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});}finally{check.close()}
 }finally{rmSync(dir,{recursive:true,force:true})}
});
