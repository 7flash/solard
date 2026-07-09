import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  console.log(`PASS ${message}`);
};

function walk(dir, out = []) {
  for (const item of readdirSync(join(root, dir))) {
    const path = join(dir, item);
    const full = join(root, path);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(path, out);
    else out.push(path.replaceAll('\\\\', '/'));
  }
  return out;
}

const files = walk('.');
assert(!files.some((file) => file.endsWith('.md')), 'no .md files');
assert(!files.some((file) => file.endsWith('.diff')), 'no .diff files');

const server = read('server.ts');
assert(server.includes('startServerWorkerSupervisor'), 'server uses direct worker supervisor');
assert(!server.includes('ensureWorkerGroup'), 'server no longer ensures child workers through bgrun');
assert(!server.includes('stopWorkerGroup'), 'server no longer stops child workers through bgrun');
assert(server.includes('await waitForShutdown()'), 'server holds until shutdown signal');

const supervisor = read('src/solard/processes/server-supervisor.ts');
assert(supervisor.includes('SOLARD_WORKER_SUPERVISOR: "server"'), 'server supervisor marks worker env');
assert(supervisor.includes('stopDetachedBgrunWorker'), 'server supervisor cleans stale detached bgrun workers');
assert(supervisor.includes('restartOnExit'), 'server supervisor restarts crashed worker children');
assert(supervisor.includes('upsertProcessStatus'), 'server supervisor writes process status');

const bgrun = read('src/solard/processes/bgrun.ts');
assert(bgrun.includes('const serverManaged = supervisor === "server"'), 'process status recognizes server-supervised workers');

const store = read('src/solard/db/terminal-store.ts');
assert(store.includes('const mergedData = {'), 'process status merges existing data');
assert(store.includes('SELECT dataJson FROM processStatus'), 'process status preserves supervisor metadata across worker heartbeats');
