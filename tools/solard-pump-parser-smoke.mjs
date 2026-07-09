import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function file(path) { const full = join(root, path); assert(existsSync(full), `missing ${path}`); return readFileSync(full, 'utf8'); }
function disc(label) { return '0x' + createHash('sha256').update(label).digest().subarray(0,8).toString('hex'); }

const parser = file('src/solard/pump/pump-parser.ts');
assert(parser.includes('PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"'), 'pump program missing');
assert(parser.includes('PUMPSWAP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"'), 'pumpswap program missing');
assert(parser.includes('PUMP_CREATE_V2_DISC = disc("global:create_v2")'), 'create_v2 discriminator missing');
assert(parser.includes('PUMP_BUY_DISC = disc("global:buy")'), 'buy discriminator missing');
assert(parser.includes('PUMP_SELL_DISC = disc("global:sell")'), 'sell discriminator missing');
assert(parser.includes('parsePumpEvent'), 'anchor event parser missing');
assert(parser.includes('deriveAssociatedBondingCurveAta'), 'associated bonding curve derivation missing');
assert(parser.includes('decodeBondingCurveAccount'), 'bonding curve decoder missing');
assert(parser.includes('bondingCurveProgressPct'), 'graduation progress helper missing');
assert(disc('global:create_v2') === '0xd6904cec5f8b31b4', 'create_v2 discriminator changed');
assert(disc('global:buy') === '0x66063d1201daebea', 'buy discriminator changed');
assert(disc('global:sell') === '0x33e685a4017f83ad' || disc('global:sell') === '0x33e17a3a30c5e311', 'sell discriminator expectation mismatch');

const helius = file('src/solard/workers/helius-live-worker.ts');
assert(helius.includes('helius-live-v4-pump-parser'), 'helius worker build id not updated');
assert(helius.includes('parsePumpTransaction'), 'helius worker not using parser');
assert(helius.includes('parsed.completes'), 'helius worker not surfacing complete events');

const bgrun = file('src/solard/processes/bgrun.ts');
assert(bgrun.includes('helius-live-v4-pump-parser'), 'bgrun expected build id not updated');

const runtime = file('src/web/client/runtime.tsx');
assert(runtime.includes('const initialMarketCapUsd = initial'), 'initialMarketCapUsd ReferenceError guard missing');
assert(runtime.includes('(globalThis as any).API = api'), 'global API compatibility missing');

console.log('PASS solard-pump-parser-smoke');
