import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { initProfile } from '@deepseek-ai/dsh-app-boot';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const dshBin = require.resolve('@deepseek-ai/dsh/lib/bin.js');

// ── Configurable timeouts (environment-overridable, sensible defaults) ────────
const msEnv = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : def; };
const BOOT_COLD_TIMEOUT_MS = msEnv('FORMA_BOOT_COLD_TIMEOUT_MS', 90_000); // first boot of a fresh profile
const BOOT_RESTART_TIMEOUT_MS = msEnv('FORMA_BOOT_RESTART_TIMEOUT_MS', 60_000); // re-boot of an already-warmed profile
const BOOT_NO_READY_TIMEOUT_MS = msEnv('FORMA_BOOT_NO_READY_TIMEOUT_MS', 8_000); // tamper probes expect NO ready
const PACK_TIMEOUT_MS = msEnv('FORMA_PACK_TIMEOUT_MS', 300_000);
const INSTALL_TIMEOUT_MS = msEnv('FORMA_INSTALL_TIMEOUT_MS', 600_000); // tarball install runs pnpm under the hood
const REMOVE_TIMEOUT_MS = msEnv('FORMA_REMOVE_TIMEOUT_MS', 600_000); // tarball remove must really finish
const CANDIDATE_INSTALL_TIMEOUT_MS = msEnv('FORMA_CANDIDATE_INSTALL_TIMEOUT_MS', 300_000);
const CANDIDATE_REMOVE_TIMEOUT_MS = msEnv('FORMA_CANDIDATE_REMOVE_TIMEOUT_MS', 300_000);
const PHASE_DEFAULT_TIMEOUT_MS = msEnv('FORMA_PHASE_TIMEOUT_MS', 300_000);
const SHUTDOWN_TIMEOUT_MS = msEnv('FORMA_SHUTDOWN_TIMEOUT_MS', 30_000);

const cleanEnv = (home, extra = {}) => ({ PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, COMSPEC: process.env.ComSpec, PATHEXT: process.env.PATHEXT, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...extra });

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID().slice(0, 8);
const work = join(root, '.work', `dsh-forma-${runId}`);
const evidence = join(root, 'evidence', `dsh-forma-${runId}`);
const home = join(work, 'dsh-home');
const managed = join(work, 'managed');
const profile = join(home, 'profiles', 'forma-test');
const pluginDir = root;
const token = randomUUID();
const source = resolve(process.env.FORMA_TEST_SOURCE_DIR ?? '');
if (!process.env.FORMA_TEST_SOURCE_DIR) throw new Error('FORMA_TEST_SOURCE_DIR_REQUIRED');
const fixtures = resolve(source, '..', '..');
const env = cleanEnv(home, { FORMA_WORK_ROOT: managed, FORMA_SOURCE_ROOTS_JSON: JSON.stringify([fixtures]), FORMA_REVIEWED_SOURCE_ROOTS_JSON: JSON.stringify([fixtures]), FORMA_NPM_EXEC_PATH: process.env.npm_execpath ?? '' });

// ── Progress / phase tracking (synchronous writes, no async race) ────────────
const startedAtIso = new Date().toISOString();
const phases = [];
const checks = [];
let metaStatus = 'running';
let lastError = null;
function saveSync(name, value) { try { writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n'); } catch { /* best-effort */ } }
function progressPayload() {
  const done = phases.filter(p => p.status !== 'running');
  return {
    schema_version: 1,
    script_run_id: runId,
    started_at: startedAtIso,
    now: new Date().toISOString(),
    status: metaStatus,
    current_phase: phases.find(p => p.status === 'running')?.name ?? null,
    phases_done: done.length,
    phases_total: phases.length,
    checks_passed: checks.filter(c => c.status === 'passed').length,
    checks_failed: checks.filter(c => c.status !== 'passed').length,
    last_error: lastError,
    phases,
  };
}
function beginPhase(name) { phases.push({ name, status: 'running', started_at: new Date().toISOString() }); saveSync('progress.json', progressPayload()); }
function endPhase(name, status, err) {
  const p = phases.find(x => x.name === name && x.status === 'running');
  if (p) { p.status = status; p.ended_at = new Date().toISOString(); p.duration_ms = Math.max(0, Date.now() - Date.parse(p.started_at)); if (err) p.error = String(err?.message ?? err); }
  saveSync('progress.json', progressPayload());
}
function recordCheck(name, status, extra = {}) {
  const peers = phases.filter(x => x.name === name);
  const p = peers[peers.length - 1];
  const duration_ms = p?.duration_ms ?? null;
  checks.push({ name, status, duration_ms, ...(status !== 'passed' && extra.error ? { error: extra.error } : {}) });
}
const save = (name, value) => writeFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n');

// ── Process helpers ────────────────────────────────────────────────────────────
function killTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* ignore */ }
}

async function run(command, args, options = {}) {
  const { cwd, env: envOverride, timeoutMs = PHASE_DEFAULT_TIMEOUT_MS, label = 'run' } = options;
  const started = Date.now();
  beginPhase(label);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, cwd, env: envOverride, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const fail = (err, status) => { if (settled) return; settled = true; clearTimeout(timer); endPhase(label, status, err); saveSync(`phase-${label}.json`, { phase: label, status, error: err?.message, elapsed_ms: Date.now() - started, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }); rejectRun(err); };
    const timer = setTimeout(() => { killTree(child); fail(Object.assign(new Error(`PHASE_TIMEOUT ${label} after ${timeoutMs}ms`), { code: null, timedOut: true, stdout, stderr, elapsed_ms: Date.now() - started }), 'timeout'); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', error => fail(error, 'error'));
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { endPhase(label, 'passed'); recordCheck(label, 'passed'); resolveRun({ code, stdout, stderr }); }
      else fail(Object.assign(new Error(`COMMAND_FAILED (${code}): ${stderr.slice(-3000)}`), { code, stdout, stderr, elapsed_ms: Date.now() - started }), 'failed');
    });
  });
}

async function capture(name, action) {
  const started = Date.now();
  beginPhase(name);
  try {
    const value = await action();
    endPhase(name, 'passed');
    recordCheck(name, 'passed');
    await save(name + '.json', value);
    return value;
  } catch (error) {
    endPhase(name, 'failed', error);
    recordCheck(name, 'failed', { error: error.message });
    lastError = error.message;
    throw error;
  }
}

async function boot({ expectReady = true, profileName = 'forma-test', readyPrefix = 'FORMA_PLUGIN_READY', shutdownPath = '/forma/plugin/shutdown', homeEnv = env, timeoutMs = null, cold = true, phaseLabel = null } = {}) {
  const resolvedTimeout = timeoutMs ?? (expectReady ? (cold ? BOOT_COLD_TIMEOUT_MS : BOOT_RESTART_TIMEOUT_MS) : BOOT_NO_READY_TIMEOUT_MS);
  const label = phaseLabel ?? `boot:${profileName}:${cold ? 'cold' : 'restart'}`;
  const started = Date.now();
  beginPhase(label);
  const child = spawn(process.execPath, [dshBin, '--profile', profileName], { cwd: work, env: homeEnv, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  const bootFailure = (code, kind, extraMessage = '') => {
    const info = { phase: label, profile: profileName, pid: child.pid ?? null, elapsed_ms: Date.now() - started, timeout_ms: resolvedTimeout, kind, code, stdout: stdout.slice(-6000), stderr: stderr.slice(-6000) };
    saveSync(`boot-failure-${profileName.replace(/[^a-z0-9-]/gi, '_')}.json`, info);
    const err = Object.assign(new Error(extraMessage || `${kind} (${label})`), info);
    endPhase(label, kind === 'timeout' ? 'timeout' : 'failed', err);
    recordCheck(label, 'failed', { error: err.message });
    lastError = err.message;
    return err;
  };
  const ready = new Promise((resolveReady, reject) => {
    let settled = false;
    const settleOnce = () => { if (settled) return false; settled = true; return true; };
    const timer = setTimeout(() => {
      if (expectReady) { if (settleOnce()) { killTree(child); reject(bootFailure(null, 'timeout', `BOOT_TIMEOUT after ${resolvedTimeout}ms (${label})`)); } }
      else if (settleOnce()) { clearTimeout(timer); resolveReady(null); }
    }, resolvedTimeout);
    child.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(new RegExp(`${readyPrefix} (\\{[^\\n]+\\})`)); if (match && settleOnce()) { clearTimeout(timer); resolveReady(JSON.parse(match[1]).origin); } });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { if (settleOnce()) { clearTimeout(timer); reject(bootFailure(null, 'error', error.message)); } });
    child.once('close', code => { if (expectReady) { if (settleOnce()) { clearTimeout(timer); reject(bootFailure(code, 'exit', `BOOT_EXIT ${code} (${label})\n${stderr.slice(-3000)}`)); } } else if (settleOnce()) { clearTimeout(timer); resolveReady(null); } });
  });
  const origin = await ready;
  endPhase(label, 'passed');
  recordCheck(label, 'passed');
  return {
    child, origin, stdout: () => stdout, stderr: () => stderr, closed,
    async stop(stopLabel) {
      if (origin) { try { await fetch(origin + shutdownPath, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }); } catch { child.kill(); } }
      else child.kill();
      const code = await Promise.race([closed, new Promise(resolveCode => setTimeout(async () => { child.kill(); killTree(child); resolveCode(null); }, SHUTDOWN_TIMEOUT_MS))]);
      await killTree(child);
      await writeFile(join(evidence, stopLabel + '.log'), stdout + '\nSTDERR\n' + stderr);
      return { code, stdout, stderr };
    },
  };
}

async function callAt(running, base, name, arguments_) {
  const response = await fetch(running.origin + base + '/call', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: arguments_ }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  if (value.isError) throw new Error(value.content?.[0]?.text ?? 'DSH_TOOL_ERROR');
  return value.content?.[0]?.text ? JSON.parse(value.content[0].text) : value;
}
async function call(running, name, arguments_) { return callAt(running, '/forma/plugin', name, arguments_); }
async function callExpectError(running, name, arguments_, pattern) { return callExpectErrorAt(running, '/forma/plugin', name, arguments_, pattern); }
async function callExpectErrorAt(running, base, name, arguments_, pattern) {
  const response = await fetch(running.origin + base + '/call', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: arguments_ }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  const text = JSON.stringify(value);
  assert.match(text, pattern);
  return value;
}

async function probePnpm() {
  try { const r = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: true }); return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null; } catch { return null; }
}

const REQUIRED_CHECKS = [
  'installed', 'tool-directory', 'source-snapshot', 'capability-scan', 'capability-scan-direct',
  'selection', 'transformation-plan', 'candidate-build', 'static-validation',
  'candidate-install-tools', 'candidate-unselected-rejected', 'candidate-restart-tools',
  'candidate-uninstall-baseline',
  'single-source-snapshot', 'single-capability-scan', 'single-selection', 'single-transformation-plan',
  'single-candidate-build', 'single-static-validation', 'single-candidate-install-tools',
  'single-unselected-rejected', 'single-candidate-restart-tools', 'single-candidate-uninstall-baseline',
  'single-independent-validation', 'single-plugin-repo-export',
  'independent-validation', 'plugin-repo-export',
  'gpl-blocked', 'unknown-blocked',
  'restart-tools', 'restart-source-call',
  'tamper-rejected', 'uninstall-baseline-restored',
];

async function main() {
  await mkdir(evidence, { recursive: true });
  await mkdir(managed, { recursive: true });
  saveSync('progress.json', progressPayload());

  let exported = null, singleExport = null, snapshot = null;

  try {
    // Build the package through the real npm pack path; the generated tarball is
    // kept only under this disposable run directory.
    const npmPackArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', work];
    const packed = process.env.npm_execpath
      ? await run(process.execPath, [process.env.npm_execpath, ...npmPackArgs], { cwd: pluginDir, env, label: 'npm-pack', timeoutMs: PACK_TIMEOUT_MS })
      : await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmPackArgs, { cwd: pluginDir, env, label: 'npm-pack', timeoutMs: PACK_TIMEOUT_MS });
    const tarball = join(work, JSON.parse(packed.stdout)[0].filename);
    initProfile(profile, [], 'startup');
    const baselinePatch = [{ insert: [
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'forma-test-probe', name: `file://${join(root, 'test-support/forma-probe.mjs').replaceAll('\\', '/')}`, config: { token } },
    ] }];
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(baselinePatch));
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'forma-test', 'install', tarball, '--config.ignore-scripts=true', '--yes'], { cwd: home, env, label: 'dsh-plugin-install-main', timeoutMs: INSTALL_TIMEOUT_MS });
    await capture('installed', async () => ({ package: JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')), tarball }));
    let running = await boot({ phaseLabel: 'boot-main-cold' });
    await capture('tool-directory', () => fetch(running.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.equal(value.tools.length, 7); return value; }));
    snapshot = await capture('source-snapshot', () => call(running, 'forma_source_snapshot', { source_dir: source, canonical_uri: 'fixtures/m1/repo-tool-mit' }));
    const scan = await capture('capability-scan', () => call(running, 'forma_scan_capabilities', { run_id: snapshot.run_id }));
    assert.equal(scan.catalog.features.length, 2);
    const directScan = await capture('capability-scan-direct', () => call(running, 'forma_scan_capabilities', { source_dir: source }));
    assert.deepEqual(directScan.catalog.features.map(feature => feature.feature_id).sort(), scan.catalog.features.map(feature => feature.feature_id).sort());
    const featureIds = scan.catalog.features.map(feature => feature.feature_id);
    const selection = await capture('selection', () => call(running, 'forma_create_selection', { run_id: snapshot.run_id, feature_ids: featureIds, actor: 'dsh-forma-test', permission_ceiling: { network: [], paths: [], credentials: [] }, transformation_mode: 'direct-source' }));
    assert.deepEqual(selection.selection.selected_feature_ids, featureIds.sort());
    const transform = await capture('transformation-plan', () => call(running, 'forma_plan_transformation', { run_id: snapshot.run_id, mode: 'direct-source' }));
    const candidate = await capture('candidate-build', () => call(running, 'forma_build_candidate', { run_id: snapshot.run_id, package_name: 'aios-plugin-generated-mit' }));
    const staticValidation = await capture('static-validation', () => call(running, 'forma_validate_candidate', { run_id: snapshot.run_id }));
    assert.equal(staticValidation.validation_report.status, 'incomplete');
    const candidateBundle = JSON.parse(await readFile(candidate.report_paths.candidate_bundle));
    const candidateHome = join(work, 'candidate-dsh-home');
    const candidateProfile = join(candidateHome, 'profiles', 'candidate-test');
    const candidateEnv = cleanEnv(candidateHome, { FORMA_NPM_EXEC_PATH: process.env.npm_execpath ?? '' });
    await mkdir(candidateHome, { recursive: true });
    initProfile(candidateProfile, [], 'startup');
    await writeFile(join(candidateProfile, 'cordis.patch.yml'), yaml.dump([{ insert: [
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
      { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'candidate-test-probe', name: `file://${join(root, 'test-support/candidate-probe.mjs').replaceAll('\\', '/')}`, config: { token } },
    ] }]));
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'install', candidateBundle.internal_tarball_path, '--config.ignore-scripts=true', '--yes'], { cwd: candidateHome, env: candidateEnv, label: 'candidate-install', timeoutMs: CANDIDATE_INSTALL_TIMEOUT_MS });
    let candidateRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv, phaseLabel: 'boot-candidate-cold' });
    const candidateHealth = await capture('candidate-install-tools', () => fetch(candidateRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools.sort(), featureIds.sort()); assert.equal(value.worker_pid_distinct, true); assert.equal(value.worker_pids.length, featureIds.length); return value; }));
    function sampleArgs(feature) { const values = {}; for (const [name, schema] of Object.entries(feature.input_schema?.properties ?? {})) values[name] = schema.type === 'number' ? 1 : schema.type === 'boolean' ? true : name === 'title' ? 'Forma acceptance' : 'one two'; return values; }
    for (const feature of candidateBundle.features) await capture('candidate-call-' + feature.name, () => callAt(candidateRunning, '/candidate', feature.name, sampleArgs(feature)));
    await capture('candidate-unselected-rejected', () => callExpectErrorAt(candidateRunning, '/candidate', 'not_selected_capability', {}, /TOOL_NOT_ALLOWED/));
    await candidateRunning.stop('candidate-installed');
    candidateRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv, cold: false, phaseLabel: 'boot-candidate-restart' });
    await capture('candidate-restart-tools', () => fetch(candidateRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.equal(value.worker_pid_distinct, true); return value; }));
    for (const feature of candidateBundle.features) await capture('candidate-restart-call-' + feature.name, () => callAt(candidateRunning, '/candidate', feature.name, sampleArgs(feature)));
    await candidateRunning.stop('candidate-restarted');
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'remove', candidateBundle.package_name, '--yes'], { cwd: candidateHome, env: candidateEnv, label: 'candidate-remove', timeoutMs: CANDIDATE_REMOVE_TIMEOUT_MS });
    const candidateBaseline = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv, cold: false, phaseLabel: 'boot-candidate-baseline' });
    await capture('candidate-uninstall-baseline', () => fetch(candidateBaseline.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, []); return value; }));
    await candidateBaseline.stop('candidate-removed');
    // Repeat the independent candidate route with exactly one selected feature.
    const singleSnapshot = await capture('single-source-snapshot', () => call(running, 'forma_source_snapshot', { source_dir: source }));
    const singleScan = await capture('single-capability-scan', () => call(running, 'forma_scan_capabilities', { run_id: singleSnapshot.run_id }));
    const singleId = singleScan.catalog.features[0].feature_id;
    await capture('single-selection', () => call(running, 'forma_create_selection', { run_id: singleSnapshot.run_id, feature_ids: [singleId], permission_ceiling: { network: [], paths: [], credentials: [] }, transformation_mode: 'direct-source' }));
    await capture('single-transformation-plan', () => call(running, 'forma_plan_transformation', { run_id: singleSnapshot.run_id, mode: 'direct-source' }));
    const singleCandidate = await capture('single-candidate-build', () => call(running, 'forma_build_candidate', { run_id: singleSnapshot.run_id, package_name: 'aios-plugin-generated-single' }));
    const singleStatic = await capture('single-static-validation', () => call(running, 'forma_validate_candidate', { run_id: singleSnapshot.run_id }));
    assert.equal(singleStatic.validation_report.status, 'incomplete');
    const singleBundle = JSON.parse(await readFile(singleCandidate.report_paths.candidate_bundle));
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'install', singleBundle.internal_tarball_path, '--config.ignore-scripts=true', '--yes'], { cwd: candidateHome, env: candidateEnv, label: 'single-candidate-install', timeoutMs: CANDIDATE_INSTALL_TIMEOUT_MS });
    let singleRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv, cold: false, phaseLabel: 'boot-single-cold' });
    await capture('single-candidate-install-tools', () => fetch(singleRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, [singleId]); assert.equal(value.worker_pid_distinct, true); return value; }));
    const singleFeature = singleBundle.features[0];
    await capture('single-candidate-call', () => callAt(singleRunning, '/candidate', singleFeature.name, sampleArgs(singleFeature)));
    await capture('single-unselected-rejected', () => callExpectErrorAt(singleRunning, '/candidate', featureIds.find(id => id !== singleId), {}, /TOOL_NOT_ALLOWED/));
    await singleRunning.stop('single-candidate-installed');
    singleRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv, cold: false, phaseLabel: 'boot-single-restart' });
    await capture('single-candidate-restart-tools', () => fetch(singleRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, [singleId]); assert.equal(value.worker_pid_distinct, true); return value; }));
    await capture('single-candidate-restart-call', () => callAt(singleRunning, '/candidate', singleFeature.name, sampleArgs(singleFeature)));
    await singleRunning.stop('single-candidate-restarted');
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'remove', singleBundle.package_name, '--yes'], { cwd: candidateHome, env: candidateEnv, label: 'single-candidate-remove', timeoutMs: CANDIDATE_REMOVE_TIMEOUT_MS });
    const singleBaseline = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv, cold: false, phaseLabel: 'boot-single-baseline' });
    await capture('single-candidate-uninstall-baseline', () => fetch(singleBaseline.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, []); return value; }));
    await singleBaseline.stop('single-candidate-removed');
    const singleValidation = await capture('single-independent-validation', () => call(running, 'forma_validate_candidate', { run_id: singleSnapshot.run_id, acceptance_evidence: { 'candidate-install': true, 'candidate-call': true, 'candidate-restart': true, 'candidate-uninstall': true } }));
    assert.equal(singleValidation.validation_report.status, 'passed');
    singleExport = await capture('single-plugin-repo-export', () => call(running, 'forma_export_plugin_repo', { run_id: singleSnapshot.run_id }));
    const validation = await capture('independent-validation', () => call(running, 'forma_validate_candidate', { run_id: snapshot.run_id, acceptance_evidence: { 'candidate-install': true, 'candidate-call': true, 'candidate-restart': true, 'candidate-uninstall': true } }));
    assert.equal(validation.validation_report.status, 'passed');
    exported = await capture('plugin-repo-export', () => call(running, 'forma_export_plugin_repo', { run_id: snapshot.run_id }));
    assert.match(exported.artifact_digest, /^sha256:/);

    for (const [label, dir] of [['gpl', resolve(fixtures, 'm1/repo-tool-gpl')], ['unknown', resolve(fixtures, 'm1/repo-tool-unknown')]]) {
      const snap = await call(running, 'forma_source_snapshot', { source_dir: dir });
      await call(running, 'forma_scan_capabilities', { run_id: snap.run_id });
      await call(running, 'forma_create_selection', { run_id: snap.run_id, feature_ids: [label === 'gpl' ? 'gpl_reverse' : 'count_lines'], permission_ceiling: { network: [], paths: [], credentials: [] }, transformation_mode: 'direct-source' });
      await call(running, 'forma_plan_transformation', { run_id: snap.run_id, mode: 'direct-source' });
      await capture(`${label}-blocked`, () => callExpectError(running, 'forma_build_candidate', { run_id: snap.run_id }, label === 'gpl' ? /LICENSE_REVIEW_PENDING|LICENSE_BLOCKED/ : /LICENSE_BLOCKED/));
    }
    await running.stop('installed');
    running = await boot({ cold: false, phaseLabel: 'boot-main-restart' });
    await capture('restart-tools', () => fetch(running.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.equal(value.tools.length, 7); return value; }));
    await capture('restart-source-call', () => call(running, 'forma_source_snapshot', { source_dir: source }));

    // Launch-time integrity rejection checks. Restore every byte before continuing.
    const installedDir = join(profile, 'node_modules', 'aios-plugin-forma');
    for (const file of ['host.mjs', 'worker.mjs', 'core/lib/records.mjs', 'integrity-manifest.json', 'provenance/README.md', 'package.json']) {
      const path = join(installedDir, file);
      const bytes = await readFile(path);
      let tampered;
      if (file.endsWith('.json')) {
        const value = JSON.parse(bytes);
        if (file === 'integrity-manifest.json') tampered = Buffer.concat([bytes, Buffer.from(' \n')]);
        else tampered = Buffer.from(JSON.stringify({ ...value, _tamper_marker: 1 }, null, 2) + '\n');
      } else if (file.endsWith('.mjs')) tampered = Buffer.concat([bytes, Buffer.from('\nvoid 0;\n')]);
      else tampered = Buffer.concat([bytes, Buffer.from('\nTamper note.\n')]);
      await writeFile(path, tampered);
      const rejected = await boot({ expectReady: false, cold: false, phaseLabel: 'boot-tamper-' + file.replaceAll('/', '-') });
      assert.equal(rejected.origin, null);
      assert.match(rejected.stderr(), /INTEGRITY_MISMATCH|RUNTIME_DIGEST_MISMATCH|PLUGIN_IDENTITY_MISMATCH/);
      recordCheck('tamper-rejected:' + file, 'passed');
      await rejected.stop('tamper-' + file.replaceAll('/', '-'));
      await writeFile(path, bytes);
      const restored = await boot({ cold: false, phaseLabel: 'boot-restored-' + file.replaceAll('/', '-') });
      const restoredHealth = await fetch(restored.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(restoredHealth.status, 200);
      assert.equal((await restoredHealth.json()).tools.length, 7);
      await restored.stop('restored-' + file.replaceAll('/', '-'));
    }
    running = await boot({ cold: false, phaseLabel: 'boot-pre-remove' });
    await running.stop('pre-remove');

    // Real tarball uninstall via DSH remove. Must verify package dependency
    // removal, patch removal, empty tools after re-boot, worker exit and config
    // restore. A hard timeout terminates the process tree and records evidence
    // rather than hanging indefinitely.
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'forma-test', 'remove', 'aios-plugin-forma', '--yes'], { cwd: home, env, label: 'dsh-plugin-remove-main', timeoutMs: REMOVE_TIMEOUT_MS });
    const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(after.dsh.profile.bundles, []);
    assert.equal(after.dependencies?.['aios-plugin-forma'], undefined);
    const baseline = await boot({ cold: false, phaseLabel: 'boot-main-baseline' });
    const baselineHealth = await fetch(baseline.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(baselineHealth.status, 200);
    assert.deepEqual((await baselineHealth.json()).tools, []);
    await baseline.stop('removed');
    recordCheck('uninstall-baseline-restored', 'passed');

    metaStatus = 'passed';
  } catch (error) {
    metaStatus = 'failed';
    lastError = error.message;
    console.error('DSH_FORMA_FAILED:', error.message);
  }

  // ── finally: always write a ValidationReport ──────────────────────────────
  const passed = checks.filter(c => c.status === 'passed').map(c => c.name);
  const failed = checks.filter(c => c.status !== 'passed').map(c => c.name);
  const missing = REQUIRED_CHECKS.filter(name => !passed.some(p => p === name || p.startsWith(name + ':')));
  const lastPhase = [...phases].reverse().find(p => p.status !== 'running') ?? phases[phases.length - 1] ?? null;
  const report = {
    schema_version: 1,
    status: metaStatus,
    script_run_id: runId,
    run_id: snapshot?.run_id ?? null,
    started_at: startedAtIso,
    ended_at: new Date().toISOString(),
    required_checks: REQUIRED_CHECKS,
    checks,
    missing_checks: missing,
    failed_checks: failed,
    last_phase: lastPhase ? { name: lastPhase.name, status: lastPhase.status, duration_ms: lastPhase.duration_ms ?? null, error: lastPhase.error ?? null } : null,
    phase_timings: phases.map(p => ({ name: p.name, status: p.status, duration_ms: p.duration_ms ?? null, error: p.error ?? null })),
    checks_passed: passed.length,
    checks_failed: failed.length,
    dsh: '@deepseek-ai/dsh@0.1.3-alpha.2',
    cordis: '4.0.2',
    include: '1.0.7',
    node: process.versions.node,
    pnpm: (await probePnpm()) ?? 'not-on-PATH',
    dsh_home: home,
    evidence_dir: evidence,
    generated_artifact_digest: exported?.artifact_digest ?? null,
    export_path: exported?.plugin_repo_export_path ?? null,
    generated_candidates: [
      { mode: 'multi-selection', artifact_digest: exported?.artifact_digest ?? null, export_path: exported?.plugin_repo_export_path ?? null },
      { mode: 'single-selection', artifact_digest: singleExport?.artifact_digest ?? null, export_path: singleExport?.plugin_repo_export_path ?? null },
    ],
    limitations: [
      'No GitHub/npm publish or production profile.',
      'Worker process boundary is not an OS malicious-code sandbox.',
      'OpenAPI candidate generation remains the legacy single-tool route; multi-selection is enabled for repo-function candidates.',
      'runtime health is only verified via a live DSH boot inside this disposable DSH_HOME, not against any production profile.',
    ],
  };
  await save('ValidationReport.json', report);
  saveSync('ValidationReport.json', report);
  saveSync('progress.json', progressPayload());

  if (metaStatus === 'passed') {
    const publicPath = path => relative(root, path).split('\\').join('/');
    await writeFile(join(root, 'evidence', 'latest-dsh-forma.json'), JSON.stringify({ run_id: snapshot?.run_id, script_run_id: runId, status: 'passed', evidence_dir: publicPath(evidence), dsh_home: publicPath(home), artifact_digest: exported?.artifact_digest ?? null, export_path: publicPath(exported?.plugin_repo_export_path ?? ''), generated_candidates: { multi: { artifact_digest: exported?.artifact_digest ?? null, export_path: publicPath(exported?.plugin_repo_export_path ?? '') }, single: { artifact_digest: singleExport?.artifact_digest ?? null, export_path: publicPath(singleExport?.plugin_repo_export_path ?? '') } } }, null, 2) + '\n');
  }

  console.log(JSON.stringify(report, null, 2));
  return metaStatus;
}

main().then(status => process.exit(status === 'passed' ? 0 : 1));