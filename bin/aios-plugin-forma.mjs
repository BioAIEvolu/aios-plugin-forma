#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { isAbsolute, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { downloadReleaseAsset, cleanupDownloadedAsset } from '../lib/cloud-download.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const dshBin = require.resolve('@deepseek-ai/dsh/lib/bin.js');

const HELP = `aios-plugin-forma ${packageJson.version}

Usage:
  aios-plugin-forma install --dsh-home <absolute-dir> --profile <name> --work-root <absolute-dir> --source-root <absolute-dir>
                         [--package-url <https-github-release-url> --sha256 <64-hex> --max-download-bytes <number>]
  aios-plugin-forma inspect --dsh-home <absolute-dir> --profile <name>
  aios-plugin-forma uninstall --dsh-home <absolute-dir> --profile <name>
  aios-plugin-forma --version
  aios-plugin-forma --help

The CLI always requires an explicit DSH_HOME. It operates only on the named
disposable profile and never falls back to %USERPROFILE%\\.dsh or runs npm
postinstall side effects. npm install fetches this package; this CLI persists
the profile overlay; DSH then activates the Bundle on restart.
`;

function fail(message, code = 2) { console.error(`aios-plugin-forma: ${message}`); process.exitCode = code; }
function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--help' || item === '-h') options.help = true;
    else if (item === '--version' || item === '-v') options.version = true;
    else if (item.startsWith('--')) {
      const key = item.slice(2);
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`OPTION_VALUE_REQUIRED:${key}`);
      options[key] = value;
    } else if (!options.command) options.command = item;
    else throw new Error(`UNKNOWN_ARGUMENT:${item}`);
  }
  return options;
}
function explicitDir(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  return resolve(value);
}
function profileDir(home, profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || /^(default|production|prod|desktop)$/i.test(profile)) throw new Error('DISPOSABLE_PROFILE_REQUIRED');
  const dir = resolve(home, 'profiles', profile);
  const rel = relative(home, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PROFILE_OUTSIDE_DSH_HOME');
  return dir;
}
function dshEnv(home) {
  if (!home) throw new Error('DSH_HOME_REQUIRED');
  return { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, COMSPEC: process.env.ComSpec, PATHEXT: process.env.PATHEXT, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
}
function runDsh(home, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [dshBin, ...args], { cwd, env: dshEnv(home), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', code => code === 0 ? resolveRun({ code, stdout, stderr }) : rejectRun(Object.assign(new Error(`DSH_COMMAND_FAILED:${code}`), { code, stdout, stderr })));
  });
}
async function readPatch(file) {
  try { const text = await readFile(file, 'utf8'); return { text, value: yaml.load(text) ?? [] }; }
  catch (error) { if (error.code === 'ENOENT') return { text: '', value: [] }; throw new Error(`PROFILE_PATCH_INVALID:${error.message}`); }
}
function formaRow(config) { return { id: 'forma', name: 'aios-plugin-forma', config }; }
async function runtimeDigest() {
  const text = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8');
  return text.match(/runtimeDigest:\s*["']?([^\s"']+)/)?.[1];
}
function appendOverlay(value, row) {
  const layers = Array.isArray(value) ? value.map(layer => ({ ...layer })) : [];
  layers.push({ insert: [row] });
  return layers;
}
function removeForma(value) {
  return (Array.isArray(value) ? value : []).map(layer => ({ ...layer, insert: Array.isArray(layer.insert) ? layer.insert.filter(entry => entry.id !== 'forma') : layer.insert })).filter(layer => !Array.isArray(layer.insert) || layer.insert.length > 0);
}
async function ensureProfile(dir) {
  await mkdir(dir, { recursive: true });
  try { await access(join(dir, 'package.json')); }
  catch { await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-forma-disposable', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } }, null, 2) + '\n'); }
  try { await access(join(dir, 'cordis.patch.yml')); }
  catch { await writeFile(join(dir, 'cordis.patch.yml'), '[]\n'); }
}
async function install(options) {
  const home = explicitDir(options['dsh-home'], 'DSH_HOME');
  const dir = profileDir(home, options.profile);
  const workRoot = explicitDir(options['work-root'], 'WORK_ROOT');
  const sourceRoot = explicitDir(options['source-root'], 'SOURCE_ROOT');
  await access(sourceRoot); await mkdir(workRoot, { recursive: true });
  if ((options['package-url'] && !options.sha256) || (!options['package-url'] && options.sha256)) throw new Error('PACKAGE_URL_AND_SHA256_REQUIRED');
  let download = null;
  try {
    if (options['package-url']) download = await downloadReleaseAsset({ packageUrl: options['package-url'], sha256: options.sha256, maxDownloadBytes: options['max-download-bytes'], workRoot });
    const packageSpec = download?.path ?? packageRoot;
    await ensureProfile(dir);
    const patchFile = join(dir, 'cordis.patch.yml'); const before = await readPatch(patchFile);
    const config = { runtimeDigest: await runtimeDigest(), workRoot, sourceRootsJson: JSON.stringify([sourceRoot]), reviewedSourceRootsJson: JSON.stringify([]), timeoutMs: 15000 };
    if (!config.runtimeDigest) throw new Error('PLUGIN_PATCH_DIGEST_MISSING');
    await writeFile(patchFile, yaml.dump(appendOverlay(before.value, formaRow(config))));
    try {
      const result = await runDsh(home, ['plugin', '--profile', options.profile, 'install', packageSpec, '--config.ignore-scripts=true', '--yes'], home);
      const dump = await runDsh(home, ['--profile', options.profile, '--dump-config'], home);
      let installedVersion = packageJson.version;
      try { installedVersion = JSON.parse(await readFile(join(dir, 'node_modules', 'aios-plugin-forma', 'package.json'), 'utf8')).version ?? installedVersion; } catch { /* pnpm may expose a symlinked package path */ }
      const record = { schema_version: 1, package_name: 'aios-plugin-forma', version: installedVersion, requested_url: download?.requested_url ?? null, final_url: download?.final_url ?? null, sha256: download?.sha256 ?? null, bytes: download?.bytes ?? null, result: { status: 'installed', dsh_exit_code: result.code, dsh_output: result.stdout.trim() }, recorded_at: new Date().toISOString() };
      const recordPath = join(dir, 'forma-install-record.json'); await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
      return { status: 'installed', profile: options.profile, dsh_home: home, work_root: workRoot, source_root: sourceRoot, runtime_digest: config.runtimeDigest, package_url: download?.requested_url ?? null, final_url: download?.final_url ?? null, sha256: download?.sha256 ?? null, dsh_output: result.stdout.trim(), config_dump: dump.stdout, install_record_path: recordPath };
    } catch (error) {
      try { await runDsh(home, ['plugin', '--profile', options.profile, 'remove', 'aios-plugin-forma', '--yes'], home); } catch { /* best effort rollback */ }
      await writeFile(patchFile, before.text || '[]\n');
      throw error;
    }
  } finally {
    await cleanupDownloadedAsset(download);
  }
}
async function inspect(options) {
  const home = explicitDir(options['dsh-home'], 'DSH_HOME'); const dir = profileDir(home, options.profile); await ensureProfile(dir);
  const dump = await runDsh(home, ['--profile', options.profile, '--dump-config'], home);
  return { status: 'inspected', profile: options.profile, dsh_home: home, config_dump: dump.stdout };
}
async function uninstall(options) {
  const home = explicitDir(options['dsh-home'], 'DSH_HOME'); const dir = profileDir(home, options.profile); await ensureProfile(dir);
  const result = await runDsh(home, ['plugin', '--profile', options.profile, 'remove', 'aios-plugin-forma', '--yes'], home).catch(error => { if (!/not found|missing/i.test(error.stderr ?? '')) throw error; return { stdout: '', stderr: '' }; });
  const patchFile = join(dir, 'cordis.patch.yml'); const current = await readPatch(patchFile); await writeFile(patchFile, yaml.dump(removeForma(current.value)));
  return { status: 'uninstalled', profile: options.profile, dsh_home: home, dsh_output: result.stdout?.trim() ?? '' };
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help || (!options.command && !options.version)) { console.log(HELP); }
  else if (options.version) console.log(packageJson.version);
  else if (!['install', 'inspect', 'uninstall'].includes(options.command)) fail(`UNKNOWN_COMMAND:${options.command}`);
  else {
    if (!options['dsh-home']) throw new Error('DSH_HOME_REQUIRED');
    const result = options.command === 'install' ? await install(options) : options.command === 'inspect' ? await inspect(options) : await uninstall(options);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { fail(error.message); }
