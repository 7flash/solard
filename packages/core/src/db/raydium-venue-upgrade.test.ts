import {test,expect} from 'bun:test';
import {Database,z} from 'sqlite-zod-orm';
import {TokenSchema} from './schema.ts';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
test('adding the Raydium venue value keeps populated token rows when reopening ORM',()=>{
 const folder=mkdtempSync(join(tmpdir(),'solard-raydium-upgrade-')),path=join(folder,'db.sqlite'),options={timestamps:false,softDeletes:false};
 try{
  const oldSchema=TokenSchema.extend({venueHint:z.enum(['unknown','pump-curve','pumpswap','meteora-dbc','meteora-damm-v2','jupiter','raydium-launchlab']).default('unknown')});
  const old=new Database(path,{tokens:oldSchema},options);
  old.tokens.insert({mint:'existing',venueHint:'pumpswap',createdAtMs:1,updatedAtMs:1});old.close();
  const next=new Database(path,{tokens:TokenSchema},options);
  try{expect(next.tokens.select().all().map(x=>x.mint)).toEqual(['existing']);
   next.tokens.insert({mint:'new',venueHint:'raydium-amm',createdAtMs:2,updatedAtMs:2});
   expect(next.tokens.select().all()).toHaveLength(2);
  }finally{next.close();}
 }finally{rmSync(folder,{recursive:true,force:true});}
});
