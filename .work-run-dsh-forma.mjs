// Bootstrap dsh-forma acceptance with the Forma pnpm shim on PATH.
// scripts/dsh-forma.mjs spawns DSH directly (not via the CLI), so the dev
// harness gets the shim through its own child env — mirroring what the CLI
// does for end users.
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { resolvePnpm } from './lib/pnpm-resolve.mjs';

const root = process.cwd();
const shimHome = join(root, '.work', 'pnpm-shim-home');
const resolution = await resolvePnpm({ dshHome: shimHome });
console.log('pnpm resolution:', JSON.stringify({ provider: resolution.provider, version: resolution.version, shimDir: resolution.shimDir }));

const env = { ...process.env, FORMA_TEST_SOURCE_DIR: 'D:\\Documents\\ChatGPT\\AIOS\\fixtures\\m1\\repo-tool-mit' };
if (resolution.shimDir) {
  env.PATH = resolution.shimDir + delimiter + (env.PATH ?? '');
  env.COREPACK_HOME = join(shimHome, '.forma', 'corepack-cache');
}
const child = spawn(process.execPath, [join(root, 'scripts', 'dsh-forma.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', chunk => { out += chunk; });
child.stderr.on('data', chunk => { out += chunk; });
child.once('close', code => {
  console.log(out.slice(-3000));
  console.log('DSH_EXIT=' + code);
  process.exit(code ?? 1);
});
