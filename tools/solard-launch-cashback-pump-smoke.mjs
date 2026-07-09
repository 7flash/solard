import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [
  ['launch ui has cashback checkbox', () => read('src/web/client/pages/launch.tsx').includes('name="cashback"')],
  ['launch ui has pump suffix checkbox', () => read('src/web/client/pages/launch.tsx').includes('name="vanitySuffixPump"')],
  ['api routes through typed launch input', () => read('app/api/launch/pump/route.ts').includes('pumpLaunchInputFromRecord')],
  ['actions push cashback flag', () => read('src/solard/actions/launches.ts').includes('pushArg(argv, "cashback", true)')],
  ['actions push mint suffix flag', () => read('src/solard/actions/launches.ts').includes('pushArg(argv, "mint-suffix"')],
  ['cli parses mint suffix', () => read('src/launches/pump/token-launch-cli.ts').includes('vanitySuffixFromFlags')],
  ['cli reports vanity mint found', () => read('src/launches/pump/token-launch-cli.ts').includes('vanity mint found')],
  ['prepare passes cashback to create_v2', () => read('src/launches/pump/token-launch.ts').includes('cashback: args.cashback ?? args.token.cashback ?? false')],
  ['prepare passes mint keypair override', () => read('src/launches/pump/token-launch.ts').includes('mint: args.mint')],
  ['vanity generator checks endsWith suffix', () => read('src/launches/pump/vanity-mint.ts').includes('address.endsWith(suffix)')],
];
let failed = 0;
for (const [label, ok] of checks) {
  if (ok()) console.log(`PASS ${label}`);
  else { console.error(`FAIL ${label}`); failed++; }
}
process.exit(failed ? 1 : 0);
