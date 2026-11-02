import{test,expect}from'bun:test';import{tradeRows}from'./trade-history-csv.ts';
import { publishTradeHistory } from './trade-history-csv.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('old incomplete accounting preserves its history and does not block another token export', () => {
 const directory=mkdtempSync(join(tmpdir(),'range-history-'));
 const dbPath=join(directory,'test.sqlite'),db=new Database(dbPath);
 db.exec('CREATE TABLE tokens (mint TEXT, decimals INTEGER); CREATE TABLE settings (key TEXT, value TEXT, updatedAtMs INTEGER)');
 for(const mint of ['broken','current'])db.query('INSERT INTO tokens VALUES (?,6)').run(mint);
 db.query('INSERT INTO settings VALUES (?,?,?)').run('trade-intent:range:w:broken:1:buy',JSON.stringify({result:{status:'confirmed',signature:'old'}}),1);
 db.query('INSERT INTO settings VALUES (?,?,?)').run('trade-intent:range:w:current:1:buy',JSON.stringify({result:{status:'confirmed',signature:'new',targetTokenDeltaRaw:'1000000',solPrincipalDeltaLamports:'-100000000',networkFeeLamports:'5000'}}),2);
 db.close();
 mkdirSync(join(directory,'bot-history'));
 const previous=join(directory,'bot-history/w-broken.csv');writeFileSync(previous,'previous verified rows');
 publishTradeHistory(directory,'w',[{mint:'broken'},{mint:'current'}],{dbPath,intentPrefix:'range'});
 expect(readFileSync(previous,'utf8')).toBe('previous verified rows');
 expect(readFileSync(join(directory,'bot-history/w-current.csv'),'utf8')).toContain('OPEN');
 const aggregate=readFileSync(join(directory,'bot-trades.csv'),'utf8');
 expect(aggregate).toContain('ACCOUNTING_REVIEW');expect(aggregate).toContain('current,OPEN');
});
test('simple history pairs exact amounts, deduplicates signatures and leaves open profit blank',()=>{
 const buy={side:'buy',time:1,signature:'b',principal:'-100000000',fee:'5000',tokens:'1000000000'};
 const sell={side:'sell',time:2,signature:'s',principal:'110000000',fee:'5000',tokens:'-1000000000'};
 const rows=tradeRows([buy,sell,sell,{...buy,time:3,signature:'b2'}],6);
 expect(rows).toHaveLength(2);expect(rows[0].tokens).toBe(1000);expect(rows[0].profit_sol).toBeCloseTo(.00999,10);expect(rows[1].status).toBe('OPEN');expect(rows[1].profit_sol).toBeUndefined();
 expect(()=>tradeRows([buy,{...sell,tokens:'-1'}],6)).toThrow('Unmatched sell');
});

test('verified manual exit closes the historical position without inventing proceeds and permits the next buy',()=>{
 const buy={side:'buy',time:1,signature:'b',principal:'-100000000',fee:'5000',tokens:'1000000'};
 const rows=tradeRows([buy,{side:'external-exit',time:2,signature:'balance-proof',tokens:'1000000'},{...buy,time:3,signature:'next'}],6);
 expect(rows[0].status).toBe('EXITED_EXTERNALLY');expect(rows[0].profit_sol).toBeUndefined();expect(rows[0].sell_signature).toBeUndefined();expect(rows[1].status).toBe('OPEN');
});
