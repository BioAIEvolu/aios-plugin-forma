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
test('CLI help and version are side-effect free and do not need a profile', async () => {
  const help = await run(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /--dsh-home/); assert.match(help.stdout, /--package-url/); assert.equal(help.stderr, '');
  const version = await run(['--version']); assert.equal(version.code, 0); assert.match(version.stdout.trim(), /^0\.1\.0$/);
  const missing = await run(['inspect', '--profile', 'forma-test']); assert.notEqual(missing.code, 0); assert.match(missing.stderr, /DSH_HOME_REQUIRED/);
});
test('publication allowlist excludes evidence, probes and package-lock', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.files.some(path => path.startsWith('evidence/') || path.includes('probe.mjs') || path === 'package-lock.json'), false);
  assert.ok(pkg.bin?.['aios-plugin-forma']);
});
