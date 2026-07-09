#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.cwd();
const fail = (message) => { throw new Error(message); };
const text = (path) => readFileSync(join(root, path), 'utf8');
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const bgrun = text('src/solard/processes/bgrun.ts');
for (const needle of [
  'buildId: "helius-live-v3-source-filter-probe"',
  'buildId: "pumpportal-live-v3-source-filter-probe"',
  'buildMismatch',
  'actualBuildId !== spec.buildId',
  'source === "both"',
]) if (!bgrun.includes(needle)) fail(`missing bgrun marker: ${needle}`);

const pump = text('src/solard/workers/pumpportal-worker.ts');
if (!pump.includes('const BUILD_ID = "pumpportal-live-v3-source-filter-probe"')) fail('pumpportal worker does not publish v3 build id');
if (!pump.includes('buildId: BUILD_ID')) fail('pumpportal status does not include build id');

const helius = text('src/solard/workers/helius-live-worker.ts');
if (!helius.includes('const BUILD_ID = "helius-live-v3-source-filter-probe"')) fail('helius worker does not publish v3 build id');
if (!helius.includes('buildId: BUILD_ID')) fail('helius status does not include build id');

const store = text('src/solard/db/terminal-store.ts');
for (const needle of [
  'clearTerminalLiveData',
  'insertTerminalProbeRow',
  'source?: string | null',
  'LOWER(source) LIKE',
  'bySource:',
]) if (!store.includes(needle)) fail(`missing terminal-store marker: ${needle}`);

const feedRoute = text('app/api/terminal/feed/route.ts');
if (!feedRoute.includes('source,') || !feedRoute.includes('listTerminalFeed')) fail('terminal feed route does not pass source filter');
const probeRoute = text('app/api/terminal/probe/route.ts');
if (!probeRoute.includes('terminalProbeAction')) fail('missing terminal probe route');
const probeAction = text('src/solard/actions/terminal-probe.ts');
if (!probeAction.includes('insertTerminalProbeRow') || !probeAction.includes('listWorkerRuntimeStatus')) fail('probe action is not wired to DB+worker status');
const workersRoute = text('app/api/workers/ensure/route.ts');
if (!workersRoute.includes('clearLive') || !workersRoute.includes('clear-terminal')) {
  if (!workersRoute.includes('clearTerminalLiveData')) fail('worker ensure route cannot clear live rows');
}
const runtime = text('src/web/client/runtime.tsx');
if (!runtime.includes('runTerminalProbe') || !runtime.includes('clearLive: options.hardRestart === true')) fail('runtime probe/clearLive not wired');
const terminalPage = text('src/web/client/pages/terminal.tsx');
for (const needle of ['value="both"', 'runTerminalProbe(false)', 'runTerminalProbe(true)', 'build-mismatch']) {
  if (!terminalPage.includes(needle)) fail(`terminal page missing ${needle}`);
}
const cli = text('src/solard/cli/worker-commands.ts');
if (!cli.includes('terminalProbeAction') || !cli.includes('sub === "probe"')) fail('CLI probe command not wired');

const files = walk(root).map((p) => p.slice(root.length + 1));
const bad = files.filter((p) => ['.md', '.diff'].includes(extname(p).toLowerCase()));
if (bad.length) fail(`forbidden files included: ${bad.join(', ')}`);
console.log(JSON.stringify({ ok: true, checks: 26, files: files.length }, null, 2));
