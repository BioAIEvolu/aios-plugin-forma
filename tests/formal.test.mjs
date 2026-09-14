import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = new URL('../', import.meta.url);
test('formal package is self-contained and non-private', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, 'aios-plugin-forma');
  assert.equal(pkg.private, undefined);
  assert.ok(pkg.files.includes('core/lib/candidate.mjs'));
  assert.ok(pkg.files.includes('core/runtime/host-repo-worker.mjs'));
});
test('core has the worker dependencies needed by candidate generation', async () => {
  for (const file of ['core/lib/records.mjs', 'core/lib/catalog.mjs', 'core/lib/candidate.mjs', 'core/runtime/repo-worker.mjs']) await readFile(new URL(file, root));
});
