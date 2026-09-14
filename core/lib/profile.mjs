import { readFile, mkdir, open, rename, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { entryListSchema, applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import { digest, objectDigest } from './records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const dshBin = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const installRequire = createRequire(dshBin);

/** Invoke exact executable and argument array; no shell string or inherited credentials. */
export function cleanEnv(home, extra = {}) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...extra };
}
export function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise({ command, args, code, stdout, stderr }) : reject(Object.assign(new Error(`COMMAND_FAILED (${code}): ${stderr.slice(-3000)}`), { code, stdout, stderr })));
  });
}
export function applyStrict(base, patches) {
  const warnings = [];
  const entries = applyEntryPatches(base, patches, (message, ...args) => warnings.push({ message, args }));
  if (warnings.length) throw Object.assign(new Error('PATCH_TARGET_MISSING'), { warnings });
  return entries;
}

/** Single disposable-profile adapter. Refuses existing production/Desktop targets. */
export class CliProfileAdapter {
  constructor(home) {
    this.home = resolve(home);
    if (!this.home.startsWith(resolve(root, '.work') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('UNSUPPORTED_TARGET');
    this.dir = join(this.home, 'profiles/forma-test');
  }
  async inspect() {
    const files = {};
    for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      try { files[name] = digest(await readFile(join(this.dir, name))); } catch (error) { if (error.code !== 'ENOENT') throw error; files[name] = null; }
    }
    return { profile: 'forma-test', files, generation: objectDigest(files) };
  }
  async lock() {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, '.forma-release.lock');
    const file = await open(path, 'wx').catch(error => { if (error.code === 'EEXIST') throw new Error('PROFILE_LOCKED'); throw error; });
    await file.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    return async () => { await file.close(); await rename(path, path + '.released-' + randomUUID().slice(0, 8)); };
  }
  async preview(extraPatches = []) {
    const manifest = JSON.parse(await readFile(join(this.dir, 'package.json'), 'utf8'));
    const profileRequire = createRequire(join(this.dir, 'package.json'));
    let entries = [];
    const layers = [];
    for (const name of manifest.dsh.profile.bundles) {
      let packageFile;
      try { packageFile = installRequire.resolve(name + '/package.json'); }
      catch { packageFile = profileRequire.resolve(name + '/package.json'); }
      const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
      const path = resolve(packageFile, '..', pkg.dsh.bundle.patch);
      const patches = yaml.load(await readFile(path, 'utf8'), { schema: entryListSchema });
      entries = applyStrict(entries, patches);
      layers.push({ name, digest: objectDigest(patches) });
    }
    const own = yaml.load(await readFile(join(this.dir, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema });
    entries = applyStrict(entries, own);
    entries = applyStrict(entries, extraPatches);
    return { entries, layers, digest: objectDigest(entries) };
  }
  async mutate(operation, value, baseline) {
    if (!['add', 'remove'].includes(operation)) throw new Error('UNSUPPORTED_OPERATION');
    if (operation === 'add') {
      const path = resolve(value);
      if (!path.startsWith(resolve(root, '.work') + (process.platform === 'win32' ? '\\' : '/')) || !path.endsWith('.tgz') || (await lstat(path)).isSymbolicLink()) throw new Error('UNVERIFIED_PACKAGE_SPEC');
    } else if (value !== 'forma-m0-candidate') throw new Error('UNSUPPORTED_PACKAGE');
    const unlock = await this.lock();
    try {
      if ((await this.inspect()).generation !== baseline.generation) throw new Error('PROFILE_CHANGED');
      return await run(process.execPath, [dshBin, 'plugin', '--profile', 'forma-test', operation, value, '--config.ignore-scripts=true'], { cwd: this.home, env: cleanEnv(this.home) });
    } finally { await unlock(); }
  }
  install(spec, baseline) { return this.mutate('add', spec, baseline); }
  remove(baseline) { return this.mutate('remove', 'forma-m0-candidate', baseline); }
  async health(origin, token) {
    const response = await fetch(origin + '/forma/health', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('HEALTH_FAILED');
    return response.json();
  }
}
