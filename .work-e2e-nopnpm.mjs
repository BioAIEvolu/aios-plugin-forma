// Real end-to-end CLI run with a plain-PowerShell-like PATH: node + corepack,
// no pnpm. Proves the resolver frees users from manual PATH edits.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const node = 'C:\\Program Files\\nodejs\\node.exe';
const base = mkdtempSync(join(tmpdir(), 'forma-e2e-'));
const home = join(base, 'dsh-home');
const work = join(base, 'work');
const source = 'D:\\Documents\\ChatGPT\\AIOS\\fixtures\\m1\\repo-tool-mit';

// Simulate a normal PowerShell PATH: Windows + Node dir only (no pnpm).
const env = {
  PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs',
  SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  TEMP: process.env.TEMP, TMP: process.env.TMP,
  COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
};

function step(name, args) {
  const result = spawnSync(node, [join(root, 'bin', 'aios-plugin-forma.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
  const record = { name, args, code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null };
  writeFileSync(join(root, '.work', `e2e-${name}.json`), JSON.stringify(record, null, 2));
  console.log(`=== ${name} exit=${result.status} ===`);
  console.log(result.stdout);
  if (result.stderr) console.log('--- stderr ---\n' + result.stderr.slice(-2000));
  return result;
}

// sanity: pnpm really is absent from this PATH
const probe = spawnSync('pnpm', ['--version'], { env, encoding: 'utf8', shell: true });
console.log('probe pnpm on restricted PATH:', probe.status === 0 ? probe.stdout.trim() : `absent (code ${probe.status ?? probe.error?.code})`);

const install = step('install', ['install', '--dsh-home', home, '--profile', 'forma-e2e', '--work-root', work, '--source-root', source]);
if (install.status !== 0) process.exit(1);
step('inspect', ['inspect', '--dsh-home', home, '--profile', 'forma-e2e']);
step('inspect-json', ['inspect', '--dsh-home', home, '--profile', 'forma-e2e', '--json']);
const uninstall = step('uninstall', ['uninstall', '--dsh-home', home, '--profile', 'forma-e2e']);

const recordPath = join(home, 'profiles', 'forma-e2e', 'forma-install-record.json');
console.log('install record exists:', existsSync(recordPath));
if (existsSync(recordPath)) console.log(readFileSync(recordPath, 'utf8'));
console.log('E2E_BASE=' + base);
process.exit(uninstall.status === 0 ? 0 : 1);
