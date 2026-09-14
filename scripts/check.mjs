import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const forbidden = /(?:[A-Z]:[\\/][^\n]*AIOS[\\/]+forma|FORMA_CORE_ROOT|C:\\Users\\Admin\\\.dsh)/i;
const required = ['host.mjs', 'worker.mjs', 'supervisor.mjs', 'package.json', 'package-lock.json', 'cordis.patch.yml', 'dsh.bundle.patch', 'integrity-manifest.json', 'README.md', 'LICENSE', 'NOTICE', 'ATTRIBUTION.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'FORMAL-ACCEPTANCE.md'];
for (const name of required) await readFile(join(root, name));
for (const name of ['host.mjs', 'worker.mjs', 'supervisor.mjs', 'package.json', 'cordis.patch.yml', 'dsh.bundle.patch', 'README.md', 'provenance/README.md']) {
  const text = await readFile(join(root, name), 'utf8');
  if (forbidden.test(text)) throw new Error(`FORBIDDEN_ABSOLUTE_PATH:${name}`);
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.private === true || pkg.name !== 'aios-plugin-forma') throw new Error('PACKAGE_NOT_FORMAL');
if (!Array.isArray(pkg.files) || !pkg.files.includes('core/lib/candidate.mjs') || !pkg.files.includes('core/runtime/host-repo-worker.mjs') || !pkg.files.includes('bin/') || !pkg.files.includes('lib/cloud-download.mjs')) throw new Error('PACKAGE_FILES_INCOMPLETE');
if (pkg.files.some(path => path.startsWith('evidence/') || path === 'package-lock.json' || path.includes('probe.mjs'))) throw new Error('PACKAGE_FILES_LEAK');
const manifest = JSON.parse(await readFile(join(root, 'integrity-manifest.json'), 'utf8'));
for (const entry of manifest.files) {
  const bytes = await readFile(join(root, entry.path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) throw new Error(`INTEGRITY_MISMATCH:${entry.path}`);
}
console.log(JSON.stringify({ status: 'passed', files: manifest.files.length, core: 'embedded', package: pkg.name }));
