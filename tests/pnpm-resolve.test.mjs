import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolvePnpm, pnpmEnvFragment, findCorepackJs, PINNED_PNPM_VERSION, SHIM_SUBDIR, COREPACK_CACHE_SUBDIR } from '../lib/pnpm-resolve.mjs';

async function pathExists(path) { try { await access(path); return true; } catch { return false; } }

test('pnpm on PATH is used directly and no shim is created', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forma-pnpm-'));
  try {
    let shimWritten = false;
    const result = await resolvePnpm({
      dshHome: base,
      probe: async () => ({ ok: true, stdout: '10.9.0\n' }),
      corepackJs: 'corepack.js',
      writeShim: async () => { shimWritten = true; },
    });
    assert.deepEqual(result, { provider: 'path', version: '10.9.0', shimDir: null, corepackJs: null });
    assert.equal(shimWritten, false);
    assert.equal(await pathExists(join(base, SHIM_SUBDIR)), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('without pnpm on PATH a corepack shim is created inside DSH_HOME with the pinned version', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forma-pnpm-'));
  try {
    const probes = [];
    const probe = async (command, args, options = {}) => {
      probes.push({ command, args, env: options.env });
      // first probe: pnpm lookup on the caller PATH fails; second: shim verify succeeds
      return probes.length === 1 ? { ok: false, stdout: '', code: 1 } : { ok: true, stdout: `${PINNED_PNPM_VERSION}\n` };
    };
    const result = await resolvePnpm({ dshHome: base, probe, corepackJs: 'corepack.js', nodePath: 'node' });
    assert.equal(result.provider, 'corepack-shim');
    assert.equal(result.version, PINNED_PNPM_VERSION);
    assert.equal(result.shimDir, join(base, SHIM_SUBDIR));
    const cmd = await readFile(join(result.shimDir, 'pnpm.cmd'), 'utf8');
    assert.match(cmd, /pnpm@12\.3\.4/);
    assert.match(cmd, /corepack\.js/);
    const sh = await readFile(join(result.shimDir, 'pnpm'), 'utf8');
    assert.match(sh, /pnpm@12\.3\.4/);
    assert.equal(probes.length, 2, 'probe PATH, then verify the shim');
    assert.ok(probes[1].env.PATH.startsWith(result.shimDir + delimiter), 'shim verification uses the shim-first PATH');
    assert.equal(probes[1].env.COREPACK_HOME, join(base, COREPACK_CACHE_SUBDIR));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('neither pnpm nor corepack -> PNPM_REQUIRED with the probe outcome', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forma-pnpm-'));
  try {
    await assert.rejects(
      resolvePnpm({ dshHome: base, probe: async () => ({ ok: false, stdout: '', code: 1 }), corepackJs: null }),
      error => {
        assert.match(error.message, /^PNPM_REQUIRED:/);
        assert.match(error.message, /PATH 中未找到 pnpm/);
        assert.match(error.message, /corepack/);
        return true;
      },
    );
    assert.equal(await pathExists(join(base, SHIM_SUBDIR)), false, 'no shim left behind on failure');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('a shim that fails verification maps to PNPM_REQUIRED', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forma-pnpm-'));
  try {
    await assert.rejects(
      resolvePnpm({ dshHome: base, probe: async () => ({ ok: false, stdout: '', code: 1 }), corepackJs: 'corepack.js' }),
      /PNPM_REQUIRED:corepack shim 创建成功但验证失败/,
    );
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('pnpmEnvFragment only describes the DSH child env and never mutates process.env', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forma-pnpm-'));
  try {
    const pathBefore = process.env.PATH;
    assert.equal(pnpmEnvFragment({ provider: 'path', version: '10.9.0', shimDir: null }, base), null);
    const shimDir = join(base, SHIM_SUBDIR);
    const fragment = pnpmEnvFragment({ provider: 'corepack-shim', version: PINNED_PNPM_VERSION, shimDir }, base);
    assert.ok(fragment.PATH.startsWith(shimDir + delimiter));
    assert.ok(fragment.Path.startsWith(shimDir + delimiter));
    assert.equal(fragment.COREPACK_HOME, join(base, COREPACK_CACHE_SUBDIR));
    assert.equal(process.env.PATH, pathBefore);
    assert.equal(process.env.COREPACK_HOME, undefined, 'resolver must not set global COREPACK_HOME');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('shim is reused across calls: second resolve rewrites the same pinned shim deterministically', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forma-pnpm-'));
  try {
    // Each resolve probes twice: PATH lookup (fails), then shim verify (ok).
    const queue = [false, true, false, true];
    const probe = async () => ({ ok: queue.shift() ?? true, stdout: `${PINNED_PNPM_VERSION}\n` });
    const first = await resolvePnpm({ dshHome: base, probe, corepackJs: 'corepack.js', nodePath: 'node' });
    const second = await resolvePnpm({ dshHome: base, probe, corepackJs: 'corepack.js', nodePath: 'node' });
    assert.equal(first.shimDir, second.shimDir, 'shim location is stable and reusable');
    assert.equal(second.provider, 'corepack-shim');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('findCorepackJs resolves the corepack implementation next to the running node', () => {
  const found = findCorepackJs();
  assert.ok(found === null || found.endsWith(join('corepack', 'dist', 'corepack.js')));
});
