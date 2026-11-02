import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "solard-types-consumer-"));
function run(command, args, cwd = dir) {
  const shell = process.platform === "win32" && command === "npm";
  const result = spawnSync(command, shell ? args.map(arg => `"${arg}"`) : args,
    { cwd, encoding: "utf8", shell });
  if (result.status !== 0) {
    const log = join(dir, "failed-check.log");
    writeFileSync(log, `${result.stdout}\n${result.stderr}`);
    throw new Error(`Consumer check failed; diagnostics: ${log}\n${String(result.stdout).slice(0, 2000)}`);
  }
  return result.stdout;
}
run(process.execPath, [join(root, "scripts/build-declarations.mjs")], root);
const archives = join(dir, "archives"); mkdirSync(archives);
const dependencies = {};
for (const name of ["core", "sdk"]) {
  const result = JSON.parse(run("npm", ["pack", join(root, "packages", name), "--json", "--pack-destination", archives]));
  dependencies[`@solard/${name}`] = `file:${join(archives, result[0].filename).replaceAll("\\", "/")}`;
}
writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module", dependencies,
  overrides: dependencies, devDependencies: { typescript: "5.9.3", "@types/bun": "1.3.5" } }));
run("bun", ["install"]);
if (existsSync(join(dir, "node_modules/@meteora-ag/dlmm")))
  throw new Error("Consumer must validate SDK types without the optional DLMM package");
writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", module: "ESNext",
  moduleResolution: "Bundler", types: ["bun"],
}, files: ["consumer.ts"] }));
writeFileSync(join(dir, "consumer.ts"), `import { createSolard, createTraderSolard, createRpcPacer, type RpcPacingOptions, observeSolardRpc, withSolardRpcContext, type TradeEvent,
  type TradeListener, type PreparedTokenDeployment, type CreatorFeeGroup,
  type TransactionDraft, type TransactionGroupInput, type PlannedTransaction } from '@solard/sdk';
const sdk = createSolard({ rpcUrl: 'https://example.invalid' });
const sqdSdk = createSolard({ source: 'sqd', sqd: { portalUrl: 'https://portal.sqd.dev/datasets/solana-mainnet' } });
async function eventSourceContracts() {
  const listener = await sqdSdk.listenTrades({ tokens: [], source: 'rpc' });
  const stream = await sqdSdk.events.subscribeToken('mint', { source: 'sqd', commitment: 'finalized' });
  for await (const event of stream) { const source: 'sqd' | 'rpc' | undefined = event.eventSource; void source; }
  await stream.close(); await listener.close();
}
void eventSourceContracts;
const pacing: RpcPacingOptions = { maxRps: 4, maxConcurrent: 8, retryOn429: { attempts: 4, honorRetryAfter: true } };
const rpcPacer = createRpcPacer(pacing, fetch);
const pacedSdk = createSolard({ rpcUrl: 'https://example.invalid', rpc: rpcPacer });
const pacedTrader = createTraderSolard({ rpcUrl: 'https://example.invalid', rpc: pacing, fetch });
void pacedSdk; void pacedTrader;
// @ts-expect-error request rate must be numeric
createRpcPacer({ maxRps: '4' });
const unsubscribe = observeSolardRpc(event => { const duration: number = event.durationMs; const kind: 'rpc' | 'request' | 'http' = event.kind; void duration; void kind; });
const contextResult: Promise<number> = withSolardRpcContext({ stage: 'test' }, async () => 1);
unsubscribe(); void contextResult;
const traderFactory: typeof createTraderSolard = createTraderSolard;
async function compositionContracts(drafts: TransactionDraft[]) {
  const transaction = sdk.tx('review').claimFees('mint').transferSol('destination', { sol: '0.01' });
  const group: TransactionGroupInput = { payer: 'review', drafts, additionalWallets: ['cosigner'], cuLimit: 1000000 };
  const plans: PlannedTransaction[] = await sdk.compileGroups([group]);
  const simulation = await sdk.simulatePlan(plans[0]!);
  return { transaction, plans, simulation };
}
void compositionContracts;
async function contracts(listener: TradeListener, event: TradeEvent, deployment: PreparedTokenDeployment) {
  await listener.add(event.mint); await listener.remove(event.mint); await listener.close();
  deployment.signers.map(signer => signer.publicKey.toBase58());
  const quote: string = event.market.quoteMint;
  const price: number | null = event.market.priceSol;
  // Program-reported trading wallet (Pump/PumpSwap); absent for venues whose events omit it.
  const trader: string | null | undefined = event.trader;
  // @ts-expect-error trader is a base58 string, not a PublicKey
  const traderKey: { toBase58(): string } = event.trader;
  void trader; void traderKey;
  // @ts-expect-error listeners take mint strings
  await listener.add(123);
  return { quote, price };
}
sdk.resumeTrade('stable-intent');
sdk.reconcile('stable-intent');
async function preparedContracts() {
  const order = await sdk.prepareFastTrade({ side: 'buy', wallet: 'review', token: 'mint', amountSol: '0.1', priceSol: '0.001', priceKind: 'spot', additionalSlippageBps: 74 });
  const expires: number = order.expiresAt;
  const refreshed = await order.refresh();
  const receipt = await refreshed.execute({ intentKey: 'review-only', signal: new AbortController().signal });
  const status: 'confirmed' | 'failed' | 'unresolved' = receipt.status;
  return { expires, status };
}
void preparedContracts;
void traderFactory; void contracts;
type Trader = ReturnType<typeof createTraderSolard>;
type Snapshot = Awaited<ReturnType<Trader['snapshotHolders']>>;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const snapshotMustBeTyped: IsAny<Snapshot> = false;
async function durableContracts(trader: Trader, snapshot: Snapshot, fee: CreatorFeeGroup) {
  const supply: bigint = snapshot.supplyRaw;
  const claimId: string = fee.key;
  const quote: string = fee.quoteMint;
  const receipt = await trader.resumeTrade('persistent-intent');
  const status: 'confirmed' | 'failed' | 'unresolved' = receipt.status;
  // @ts-expect-error snapshots retain bigint supply
  const wrongSupply: string = snapshot.supplyRaw;
  return { supply, claimId, quote, status };
}
void snapshotMustBeTyped; void durableContracts;
`);
const files = run("bun", ["run", "tsc", "--noEmit", "--listFiles"]);
if (/[\\/]@solard[\\/](?:core|sdk)[\\/]src[\\/].*\.ts/m.test(files))
  throw new Error("Consumer traversed Solard implementation source");
if (/[\\/]measure-fn[\\/].*(?<!\.d)\.ts$/m.test(files))
  throw new Error("Consumer traversed measure-fn implementation source");
process.stdout.write(run("bun", ["-e", "const sdk=await import('@solard/sdk'); if(typeof sdk.observeSolardRpc!=='function'||typeof sdk.withSolardRpcContext!=='function')throw Error('Missing RPC observer exports'); console.log('SDK import OK')"]));
console.log(`Strict archive consumer passed; retained at ${dir}`);
