import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['node_modules', '.git', '.work'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(relative(root, path).split('\\').join('/'));
  }
  return out;
}
// Only files shipped in the executable bundle are hashed. In particular,
// historical evidence, test probes, logs, temporary tarballs and lockfiles are
// deliberately outside the runtime manifest and the npm publication set.
const top = new Set(['host.mjs', 'worker.mjs', 'supervisor.mjs', 'package.json', 'LICENSE', 'NOTICE']);
const files = [];
const runtime = new Set(['core/runtime/host-repo-worker.mjs', 'core/runtime/repo-supervisor.mjs', 'core/runtime/repo-worker.mjs']);
for (const path of (await walk(root)).filter(path => path.startsWith('core/lib/') || runtime.has(path) || path.startsWith('bin/') || path === 'lib/cloud-download.mjs' || path.startsWith('specs/') || path.startsWith('provenance/') || top.has(path)).sort()) {
  files.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
}
await writeFile(join(root, 'integrity-manifest.json'), JSON.stringify({ schema_version: 1, files }, null, 2) + '\n');
const manifestBytes = await readFile(join(root, 'integrity-manifest.json'));
const runtimeDigest = 'sha256:' + createHash('sha256').update(JSON.stringify({ schema_version: 1, files, manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex') })).digest('hex');
console.log(JSON.stringify({ runtimeDigest, files: files.length }));
