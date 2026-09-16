import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(root, 'bin/aios-plugin-forma.mjs'), ...args], { cwd: root, windowsHide: true, shell: false, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', rejectRun); child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}
test('CLI help and version are side-effect free and do not pollute stderr', async () => {
  const help = await run(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /--dsh-home/); assert.match(help.stdout, /--package-url/); assert.match(help.stdout, /--json/); assert.equal(help.stderr, '');
  const version = await run(['--version']); assert.equal(version.code, 0); assert.match(version.stdout.trim(), /^0\.2\.0$/); assert.equal(version.stderr, '');
  const missing = await run(['inspect', '--profile', 'forma-test']); assert.equal(missing.code, 2); assert.match(missing.stderr, /DSH_HOME_REQUIRED/); assert.match(missing.stderr, /--dsh-home/);
});
test('--json help and version each print exactly one stable JSON document', async () => {
  const help = await run(['--json', '--help']); assert.equal(help.code, 0); assert.equal(help.stderr, '');
  const helpJson = JSON.parse(help.stdout); assert.equal(helpJson.schema_version, 1); assert.equal(helpJson.command, 'help'); assert.equal(helpJson.version, '0.2.0');
  const version = await run(['--json', '--version']); assert.equal(version.code, 0); assert.equal(version.stderr, '');
  assert.equal(JSON.parse(version.stdout).version, '0.2.0');
});
test('usage errors honour human and --json modes with exit code 2', async () => {
  const unknown = await run(['frobnicate']); assert.equal(unknown.code, 2); assert.match(unknown.stderr, /UNKNOWN_COMMAND/); assert.match(unknown.stderr, /--help/); assert.equal(unknown.stdout, '');
  const unknownJson = await run(['--json', 'frobnicate']); assert.equal(unknownJson.code, 2); assert.equal(unknownJson.stderr, '');
  const payload = JSON.parse(unknownJson.stdout); assert.equal(payload.status, 'error'); assert.equal(payload.error.machine_code, 'UNKNOWN_COMMAND'); assert.equal(payload.error.exit_code, 2);
  const missingValue = await run(['install', '--dsh-home']); assert.equal(missingValue.code, 2); assert.match(missingValue.stderr, /OPTION_VALUE_REQUIRED/);
  const missingValueJson = await run(['--json', 'install', '--dsh-home']); assert.equal(missingValueJson.code, 2);
  assert.equal(JSON.parse(missingValueJson.stdout).error.machine_code, 'OPTION_VALUE_REQUIRED');
  const production = await run(['inspect', '--dsh-home', root, '--profile', 'production']); assert.equal(production.code, 2); assert.match(production.stderr, /DISPOSABLE_PROFILE_REQUIRED/);
});
test('publication allowlist excludes evidence, probes and package-lock but ships the CLI library', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.files.some(path => path.startsWith('evidence/') || path.includes('probe.mjs') || path === 'package-lock.json'), false);
  assert.ok(pkg.bin?.['aios-plugin-forma']);
  assert.ok(pkg.files.includes('lib/cli.mjs'));
  assert.ok(pkg.files.includes('lib/cloud-download.mjs'));
  assert.ok(pkg.files.includes('lib/pnpm-resolve.mjs'));
});
