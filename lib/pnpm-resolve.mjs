import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The pnpm version validated end-to-end by this repository's DSH acceptance.
export const PINNED_PNPM_VERSION = '12.3.4';
// Both live inside the caller-specified (disposable) DSH_HOME; never in the
// package, never in a user/system-wide location.
export const SHIM_SUBDIR = join('.forma', 'shims');
export const COREPACK_CACHE_SUBDIR = join('.forma', 'corepack-cache');

function defaultProbe(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', ...options });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', code: result.error?.code ?? result.status ?? null };
}

/** Locate the corepack implementation shipped with the running Node. */
export function findCorepackJs(nodePath = process.execPath, exists = existsSync) {
  const candidate = join(dirname(nodePath), 'node_modules', 'corepack', 'dist', 'corepack.js');
  return exists(candidate) ? candidate : null;
}

async function defaultWriteShim({ shimDir, nodePath, corepackJs, version }) {
  await mkdir(shimDir, { recursive: true });
  const spec = `pnpm@${version}`;
  // Windows entry: cmd batch resolved through PATH by DSH's shell:true spawn.
  await writeFile(join(shimDir, 'pnpm.cmd'), `@echo off\r\n"${nodePath}" "${corepackJs}" ${spec} %*\r\n`);
  // POSIX entry for non-Windows hosts.
  await writeFile(join(shimDir, 'pnpm'), `#!/bin/sh\nexec "${nodePath}" "${corepackJs}" ${spec} "$@"\n`, { mode: 0o755 });
}

/**
 * Resolve a usable pnpm without touching system/user-global PATH.
 *
 * Order: (1) pnpm already on the caller's PATH; (2) a Forma-owned shim inside
 * the caller-specified DSH_HOME that forwards to the Node-bundled corepack
 * with a pinned pnpm version; (3) PNPM_REQUIRED with the probe results.
 * The returned shimDir is only ever prepended to the DSH child-process env —
 * process.env.PATH and the system configuration are never modified. The shim
 * and the corepack cache are retained for reuse until the disposable
 * DSH_HOME itself is deleted; uninstall never removes them.
 */
export async function resolvePnpm({ dshHome, probe = defaultProbe, corepackJs = findCorepackJs(), nodePath = process.execPath, writeShim = defaultWriteShim } = {}) {
  const onPath = await probe('pnpm', ['--version']);
  if (onPath.ok) {
    return { provider: 'path', version: onPath.stdout.trim().split(/\r?\n/)[0] || null, shimDir: null, corepackJs: null };
  }
  if (corepackJs) {
    const shimDir = join(dshHome, SHIM_SUBDIR);
    const cacheDir = join(dshHome, COREPACK_CACHE_SUBDIR);
    await writeShim({ shimDir, nodePath, corepackJs, version: PINNED_PNPM_VERSION });
    const verify = await probe('pnpm', ['--version'], { env: { ...process.env, PATH: shimDir + delimiter + (process.env.PATH ?? ''), COREPACK_HOME: cacheDir } });
    if (!verify.ok) {
      throw new Error(`PNPM_REQUIRED:corepack shim 创建成功但验证失败（pnpm@${PINNED_PNPM_VERSION} 无法经 corepack 启动，可能缺少网络访问 npm registry）`);
    }
    return { provider: 'corepack-shim', version: PINNED_PNPM_VERSION, shimDir, corepackJs };
  }
  throw new Error('PNPM_REQUIRED:PATH 中未找到 pnpm，且当前 Node 未附带可用的 corepack');
}

/** Child-process env fragment for the DSH invocation; undefined when unneeded. */
export function pnpmEnvFragment(resolution, dshHome) {
  if (resolution?.provider !== 'corepack-shim' || !resolution.shimDir) return null;
  const shimmed = resolution.shimDir + delimiter + (process.env.PATH ?? '');
  return { PATH: shimmed, Path: shimmed, COREPACK_HOME: join(dshHome, COREPACK_CACHE_SUBDIR) };
}
