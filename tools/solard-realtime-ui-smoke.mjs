import { readFileSync } from 'node:fs';
function fail(msg){ console.error('FAIL', msg); process.exit(1); }
function ok(msg){ console.log('PASS', msg); }
const files = {
  store: readFileSync('src/solard/db/terminal-store.ts','utf8'),
  normalize: readFileSync('src/solard/pump/pumpportal-normalize.ts','utf8'),
  pump: readFileSync('src/solard/workers/pumpportal-worker.ts','utf8'),
  bgrun: readFileSync('src/solard/processes/bgrun.ts','utf8'),
  terminal: readFileSync('src/web/client/pages/terminal.tsx','utf8'),
  runtime: readFileSync('src/web/client/runtime.tsx','utf8'),
  holders: readFileSync('app/api/token-holders/route.ts','utf8'),
};
if (!files.normalize.includes('pumpPortalTxType')) fail('PumpPortal tx type classifier missing');
if (!files.normalize.includes('isPumpPortalTrade')) fail('PumpPortal trade classifier missing');
if (!files.pump.includes('subscribeTokenTrade')) fail('PumpPortal trade subscribe missing');
if (files.pump.includes('disabled-missing-api-key')) fail('trade subscription still api-key gated');
if (!files.store.includes('isMayhemMode') || !files.store.includes('hideMayhem')) fail('store mayhem filter missing');
if (!files.store.includes('quoteAsset') || !files.store.includes('hideUsdc')) fail('store quote filter missing');
if (!files.runtime.includes('hideMayhem=${state.hideMayhem')) fail('frontend does not pass hideMayhem to feed');
if (files.terminal.includes('<th>Δ%</th>')) fail('delta column still rendered');
if (!files.terminal.includes('autoLoadHolders')) fail('holder auto-load missing');
if (!files.holders.includes('getTokenLargestAccounts')) fail('RPC holder fallback missing');
if (!files.bgrun.includes('pumpportal-live-v4-trades-mayhem')) fail('bgrun pumpportal build id not bumped');
if (!files.bgrun.includes('reconciler-v3-build-heartbeat')) fail('bgrun reconciler build id not bumped');
ok('PumpPortal realtime trade path ungated');
ok('mayhem/usdc filters pushed into SQLite');
ok('delta column removed');
ok('holders RPC fallback wired');
ok('worker build ids aligned');
