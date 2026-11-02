import{test,expect}from'bun:test';import{mkdtempSync,writeFileSync,renameSync,unlinkSync}from'fs';import{tmpdir}from'os';import{join}from'path';import{parseRangeFile,watchRangeFile}from'./range-file.ts';
const{rmSync}=require('fs')as{rmSync:(p:string,o:{recursive:boolean;force:boolean})=>void};
test('range edits validate atomically, survive rename, pause invalid edits and recover',async()=>{
 const root=mkdtempSync(join(tmpdir(),'range-file-'));const file=join(root,'range.json');const text=(b:string,s:string)=>JSON.stringify({buyPriceSol:b,sellPriceSol:s});writeFileSync(file,text('1','2'));const changes:any[]=[];const range=watchRangeFile(file,(band,error)=>changes.push({band,error}));
 try{expect(range.current.buyPriceSol).toBe('1');writeFileSync(file+'.tmp',text('3','4'));renameSync(file+'.tmp',file);await Bun.sleep(200);expect(range.current.buyPriceSol).toBe('3');
  const captured=range.current;writeFileSync(file,text('7','8'));range.refresh();expect(captured.buyPriceSol).toBe('3');expect(range.current.buyPriceSol).toBe('7');
  writeFileSync(file,'{');range.refresh();expect(range.valid).toBe(false);expect(range.current.buyPriceSol).toBe('7');
  writeFileSync(file,text('9','8'));range.refresh();expect(range.valid).toBe(false);
  writeFileSync(file,text('5','6'));range.refresh();expect(range.valid).toBe(true);expect(range.current.buyPriceSol).toBe('5');
  unlinkSync(file);range.refresh();expect(range.valid).toBe(false);
 }finally{range.close();rmSync(root,{recursive:true,force:true});}
 expect(()=>parseRangeFile('{"buyPriceSol":1,"sellPriceSol":2}')).toThrow();expect(()=>parseRangeFile('{"buyPriceSol":"1","sellPriceSol":"2","mint":"changed"}')).toThrow();
});
