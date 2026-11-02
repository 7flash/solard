import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { adoptedEntry } from "./adopted-entry.ts";

const columns = ["token", "status", "bought_at_utc", "sold_at_utc", "tokens", "buy_cost_sol", "sell_received_sol", "profit_sol", "profit_percent", "buy_price_sol", "sell_price_sol", "buy_signature", "sell_signature", "note"];
export function tradeRows(trades: any[], decimals: number) {
  const rows: Record<string, unknown>[] = []; let buy: any = null;
  const seen = new Set<string>();
  for (const t of trades.sort((a,b) => a.time-b.time)) {
    if (seen.has(t.signature)) continue; seen.add(t.signature);
    if (t.side === "buy") {
      if (buy) throw new Error("Consecutive buys require accounting review");
      buy = t; continue;
    }
    if (t.side === "external-exit") {
      if (!buy || BigInt(buy.tokens) !== BigInt(t.tokens)) throw Error("External exit amount requires accounting review");
      const tokens = Number(buy.tokens) / 10 ** decimals;
      const cost = Number(-BigInt(buy.principal) + BigInt(buy.fee)) / 1e9;
      rows.push({ status: "EXITED_EXTERNALLY", bought_at_utc: new Date(buy.time).toISOString(),
        tokens, buy_cost_sol: cost, buy_price_sol: cost / tokens, buy_signature: buy.signature,
        note: "External exit: finalized zero balance verified. Proceeds, sale time and profit await transaction accounting." });
      buy = null; continue;
    }
    if (!buy || BigInt(buy.tokens) !== -BigInt(t.tokens)) throw new Error("Unmatched sell requires accounting review");
    const cost = -BigInt(buy.principal) + BigInt(buy.fee);
    const received = BigInt(t.principal) - BigInt(t.fee);
    const tokens = Number(buy.tokens) / 10 ** decimals;
    rows.push({ status: "SOLD", bought_at_utc: new Date(buy.time).toISOString(), sold_at_utc: new Date(t.time).toISOString(), tokens,
      buy_cost_sol: Number(cost)/1e9, sell_received_sol: Number(received)/1e9, profit_sol: Number(received-cost)/1e9,
      profit_percent: Number(received-cost)/Number(cost)*100, buy_price_sol: Number(cost)/1e9/tokens,
      sell_price_sol: Number(received)/1e9/tokens, buy_signature: buy.signature, sell_signature: t.signature,
      note: t.note ?? "Recorded network fees included; other wallet costs not independently audited" }); buy=null;
  }
  if (buy) { const tokens=Number(buy.tokens)/10**decimals; const cost=Number(-BigInt(buy.principal)+BigInt(buy.fee))/1e9;
    rows.push({status:"OPEN",bought_at_utc:new Date(buy.time).toISOString(),tokens,buy_cost_sol:cost,buy_price_sol:cost/tokens,buy_signature:buy.signature,note:"Not sold; profit remains blank"}); }
  return rows;
}
const csv = (rows: Record<string, unknown>[]) => [columns.join(","),...rows.map(r=>columns.map(c=>{let v=r[c];if(typeof v==="number")v=Number.isInteger(v)?v:v.toFixed(c==="profit_percent"?3:12).replace(/0+$/,"").replace(/\.$/,"");const s=v==null?"":String(v);return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join(","))].join("\r\n")+"\r\n";
export function publishTradeHistory(directory: string, wallet: string, identities: {mint:string}[], options: { dbPath?: string; intentPrefix?: "range" } = {}) {
  const cfg=options.dbPath ? {} : Bun.TOML.parse(readFileSync(join(directory,".config.toml"),"utf8")) as any;
  const db=new Database(options.dbPath??cfg.slrd?.db_path??cfg.slrd_db_path??cfg.SLRD_DB_PATH,{readonly:true});
  const all:Record<string,unknown>[]=[]; mkdirSync(join(directory,"bot-history"),{recursive:true});
  const write=(path:string,rows:Record<string,unknown>[])=>{writeFileSync(path+`.${process.pid}.tmp`,csv(rows));renameSync(path+`.${process.pid}.tmp`,path);};
  try { for(const {mint} of identities) { try {
    const meta=db.query("SELECT decimals FROM tokens WHERE mint=?").get(mint) as any;if(meta?.decimals==null)throw new Error(`Missing decimals for ${mint}`);
    const intents=db.query("SELECT key,value,updatedAtMs FROM settings WHERE key LIKE ? OR key LIKE ? ORDER BY updatedAtMs").all(options.intentPrefix === "range" ? `trade-intent:range:${wallet}:${mint}:%` : `trade-intent:${wallet}:${mint}:%`, options.intentPrefix === "range" ? "__no_manual_range_exit__" : `trade-intent:user-exit:%:${mint}`) as any[];
    const trades: any[]=intents.flatMap(i=>{const v=JSON.parse(i.value,(_,x)=>x&&typeof x==="object"&&typeof x.$bigint==="string"?x.$bigint:x);let r=v.result;if(r?.status!=="confirmed")return [];
      if(r.targetTokenDeltaRaw==null || r.solPrincipalDeltaLamports==null){
        const proofPath=join(directory,`.docs/recovery/all-bot-exits-2026-10-22/${mint}-chain-proof.json`);
        if(!existsSync(proofPath))throw new Error(`Confirmed accounting incomplete for ${mint}`);
        const t=JSON.parse(readFileSync(proofPath,"utf8"));
        if(t.transaction.signatures[0]!==r.signature || t.meta.err)throw new Error("Accounting proof signature mismatch");
        const owner=v.wallet, index=t.transaction.message.accountKeys.findIndex((a:any)=>(a.pubkey??a)===owner);
        const sum=(rows:any[])=>rows.filter(x=>x.owner===owner&&x.mint===mint).reduce((n,x)=>n+BigInt(x.uiTokenAmount.amount),0n);
        if(index<0)throw new Error("Accounting wallet missing from proof");
        r={...r,targetTokenDeltaRaw:String(sum(t.meta.postTokenBalances)-sum(t.meta.preTokenBalances)),
          solPrincipalDeltaLamports:String(BigInt(t.meta.postBalances[index])-BigInt(t.meta.preBalances[index])+BigInt(t.meta.fee)),networkFeeLamports:String(t.meta.fee)};
      }
return [{side:i.key.startsWith("trade-intent:user-exit:") ? "sell" : i.key.split(":").at(-1),time:i.updatedAtMs,signature:r.signature??v.submissions.at(-1)?.signature,principal:r.solPrincipalDeltaLamports,fee:r.networkFeeLamports??"0",tokens:r.targetTokenDeltaRaw}];});
    const adoptedPath=join(directory,"bot-adoptions",`${wallet}-${mint}.json`);
    if(existsSync(adoptedPath))trades.push(adoptedEntry(JSON.parse(readFileSync(adoptedPath,"utf8")),wallet,mint));
    // Include the independently verified external exit; never fabricate an open holding.
    const evidence=join(directory,".docs/analysis/sma-2026-10-22/de5-chain-exit.json");
    if(mint==="De5V2NfBFpUqZor8wyQ88LH3uVNPBVuTBNe6TeRfpump"&&existsSync(evidence)) {
      const e=JSON.parse(readFileSync(evidence,"utf8"));const owner=e.signers[0].pubkey;const b=e.pre.find((x:any)=>x.owner===owner&&x.mint===mint);const a=e.post.find((x:any)=>x.owner===owner&&x.mint===mint);
      if(e.err==null&&b&&a)trades.push({side:"sell",time:e.time*1000,signature:e.signature,principal:String(e.postSol[0]-e.preSol[0]+e.fee),fee:String(e.fee),tokens:String(BigInt(a.uiTokenAmount.amount)-BigInt(b.uiTokenAmount.amount)),note:"External exit: observed net wallet SOL change; see saved chain evidence"});
    }
    const externalProof=join(directory,`.docs/recovery/all-bot-exits-2026-10-22/${mint}-external-proof.json`);
    if(existsSync(externalProof)){
      const e=JSON.parse(readFileSync(externalProof,"utf8")),t=e.transaction;
      const owner=t.transaction.message.accountKeys.find((x:any)=>x.signer)?.pubkey;
      const idx=t.transaction.message.accountKeys.findIndex((x:any)=>x.pubkey===owner);
      const sum=(rows:any[])=>rows.filter(x=>x.owner===owner&&x.mint===mint).reduce((n,x)=>n+BigInt(x.uiTokenAmount.amount),0n);
      if(t.meta.err==null&&idx>=0)trades.push({side:"sell",time:t.blockTime*1000,signature:e.signature,
        principal:String(BigInt(t.meta.postBalances[idx])-BigInt(t.meta.preBalances[idx])+BigInt(t.meta.fee)),fee:String(t.meta.fee),
        tokens:String(sum(t.meta.postTokenBalances)-sum(t.meta.preTokenBalances)),note:"External exit: observed wallet SOL movement, may include rent/other same-transaction effects"});
    }
    const statePath=join(directory,`bot-${wallet}-${mint}.json`);
    const external=existsSync(statePath)?JSON.parse(readFileSync(statePath,"utf8")).externalExit:null;
    if((external?.reportedManualExit || external?.observedExternalExit) && external.amountRaw === "0" && external.previousPosition?.amountRaw)
      trades.push({side:"external-exit",time:Date.parse(external.at),signature:`external-balance:${external.slot}:${mint}`,tokens:external.previousPosition.amountRaw});
    const rows=tradeRows(trades,meta.decimals).map(r=>({token:mint,...r}));all.push(...rows);write(join(directory,"bot-history",`${wallet}-${mint}.csv`),rows);
  } catch (error) {
    // An old token's missing proof must not prevent other tokens publishing.
    // Preserve its previous detailed file; aggregate CSV explicitly marks the gap.
    const rows = [{ token: mint, status: "ACCOUNTING_REVIEW", note: error instanceof Error ? error.message : String(error) }];
    all.push(...rows);
    const path = join(directory,"bot-history",`${wallet}-${mint}.csv`);
    if (!existsSync(path)) write(path, rows);
  }
  } write(join(directory,"bot-trades.csv"),all); } finally {db.close();}
}
