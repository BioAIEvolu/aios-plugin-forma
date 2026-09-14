import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
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
const cleanEnv = (home, extra = {}) => ({ PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, COMSPEC: process.env.ComSpec, PATHEXT: process.env.PATHEXT, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...extra });
const run = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => { const child = spawn(command, args, { windowsHide: true, shell: false, ...options }); let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.once('error', rejectRun); child.once('close', code => code === 0 ? resolveRun({ code, stdout, stderr }) : rejectRun(new Error(`COMMAND_FAILED (${code}): ${stderr.slice(-3000)}`))); });
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
const reports = [];
await mkdir(evidence, { recursive: true });
await mkdir(managed, { recursive: true });
function save(name, value) { return writeFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n'); }
async function capture(name, action) {
  try { const value = await action(); reports.push({ name, status: 'passed' }); await save(name + '.json', value); return value; }
  catch (error) { reports.push({ name, status: 'failed', error: error.message }); throw error; }
}
async function boot({ expectReady = true, profileName = 'forma-test', readyPrefix = 'FORMA_PLUGIN_READY', shutdownPath = '/forma/plugin/shutdown', homeEnv = env } = {}) {
  const child = spawn(process.execPath, [dshBin, '--profile', profileName], { cwd: work, env: homeEnv, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { if (expectReady) { child.kill(); reject(new Error('BOOT_TIMEOUT\n' + stderr.slice(-3000))); } else resolveReady(null); }, expectReady ? 20000 : 4000);
    child.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(new RegExp(`${readyPrefix} (\\{[^\\n]+\\})`)); if (match) { clearTimeout(timer); resolveReady(JSON.parse(match[1]).origin); } });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { if (expectReady) { clearTimeout(timer); reject(new Error(`BOOT_EXIT ${code}\n${stderr.slice(-3000)}`)); } else { clearTimeout(timer); resolveReady(null); } });
  });
  const origin = await ready;
  const killTree = async () => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      child.kill();
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  };
  return { child, origin, stdout: () => stdout, stderr: () => stderr, closed, async stop(label) {
    if (origin) { try { await fetch(origin + shutdownPath, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }); } catch { child.kill(); } }
    else child.kill();
    const code = await Promise.race([closed, new Promise(async resolveCode => { setTimeout(async () => { child.kill(); await killTree(); resolveCode(null); }, 5000); })]);
    await killTree();
    await writeFile(join(evidence, label + '.log'), stdout + '\nSTDERR\n' + stderr);
    return { code, stdout, stderr };
  } };
}
async function callAt(running, base, name, arguments_) {
  const response = await fetch(running.origin + base + '/call', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: arguments_ }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  if (value.isError) throw new Error(value.content?.[0]?.text ?? 'DSH_TOOL_ERROR');
  return value.content?.[0]?.text ? JSON.parse(value.content[0].text) : value;
}
async function call(running, name, arguments_) { return callAt(running, '/forma/plugin', name, arguments_); }
async function callExpectError(running, name, arguments_, pattern) {
  return callExpectErrorAt(running, '/forma/plugin', name, arguments_, pattern);
}
async function callExpectErrorAt(running, base, name, arguments_, pattern) {
  const response = await fetch(running.origin + base + '/call', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: arguments_ }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  const text = JSON.stringify(value);
  assert.match(text, pattern);
  return value;
}

// Build the package through the real npm pack path; the generated tarball is
// kept only under this disposable run directory.
const npmPackArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', work];
const packed = process.env.npm_execpath
  ? await run(process.execPath, [process.env.npm_execpath, ...npmPackArgs], { cwd: pluginDir, env })
  : await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmPackArgs, { cwd: pluginDir, env });
const tarball = join(work, JSON.parse(packed.stdout)[0].filename);
initProfile(profile, [], 'startup');
const baselinePatch = [{ insert: [
  { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
  { id: 'forma-test-probe', name: `file://${join(root, 'test-support/forma-probe.mjs').replaceAll('\\', '/')}`, config: { token } },
] }];
await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(baselinePatch));
await run(process.execPath, [dshBin, 'plugin', '--profile', 'forma-test', 'install', tarball, '--config.ignore-scripts=true', '--yes'], { cwd: home, env });
await capture('installed', async () => ({ package: JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')), tarball }));
let running = await boot();
await capture('tool-directory', () => fetch(running.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.equal(value.tools.length, 7); return value; }));
const snapshot = await capture('source-snapshot', () => call(running, 'forma_source_snapshot', { source_dir: source, canonical_uri: 'fixtures/m1/repo-tool-mit' }));
const scan = await capture('capability-scan', () => call(running, 'forma_scan_capabilities', { run_id: snapshot.run_id }));
assert.equal(scan.catalog.features.length, 2);
const directScan = await capture('capability-scan-direct', () => call(running, 'forma_scan_capabilities', { source_dir: source }));
assert.deepEqual(directScan.catalog.features.map(feature => feature.feature_id).sort(), scan.catalog.features.map(feature => feature.feature_id).sort());
const featureIds = scan.catalog.features.map(feature => feature.feature_id);
const selection = await capture('selection', () => call(running, 'forma_create_selection', { run_id: snapshot.run_id, feature_ids: featureIds, actor: 'dsh-forma-test', permission_ceiling: { network: [], paths: [], credentials: [] }, transformation_mode: 'direct-source' }));
assert.deepEqual(selection.selection.selected_feature_ids, featureIds.sort());
// The tool resolves the report digest from the snapshotted report when omitted.
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
await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'install', candidateBundle.internal_tarball_path, '--config.ignore-scripts=true', '--yes'], { cwd: candidateHome, env: candidateEnv });
let candidateRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv });
const candidateHealth = await capture('candidate-install-tools', () => fetch(candidateRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools.sort(), featureIds.sort()); assert.equal(value.worker_pid_distinct, true); assert.equal(value.worker_pids.length, featureIds.length); return value; }));
function sampleArgs(feature) { const values = {}; for (const [name, schema] of Object.entries(feature.input_schema?.properties ?? {})) values[name] = schema.type === 'number' ? 1 : schema.type === 'boolean' ? true : name === 'title' ? 'Forma acceptance' : 'one two'; return values; }
for (const feature of candidateBundle.features) await capture('candidate-call-' + feature.name, () => callAt(candidateRunning, '/candidate', feature.name, sampleArgs(feature)));
await capture('candidate-unselected-rejected', () => callExpectErrorAt(candidateRunning, '/candidate', 'not_selected_capability', {}, /TOOL_NOT_ALLOWED/));
await candidateRunning.stop('candidate-installed');
candidateRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv });
await capture('candidate-restart-tools', () => fetch(candidateRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.equal(value.worker_pid_distinct, true); return value; }));
for (const feature of candidateBundle.features) await capture('candidate-restart-call-' + feature.name, () => callAt(candidateRunning, '/candidate', feature.name, sampleArgs(feature)));
await candidateRunning.stop('candidate-restarted');
await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'remove', candidateBundle.package_name, '--yes'], { cwd: candidateHome, env: candidateEnv });
const candidateBaseline = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv });
await capture('candidate-uninstall-baseline', () => fetch(candidateBaseline.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, []); return value; }));
await candidateBaseline.stop('candidate-removed');
// Repeat the independent candidate route with exactly one selected feature.
// This guards the single-tool shape separately from the multi-capability path.
const singleSnapshot = await capture('single-source-snapshot', () => call(running, 'forma_source_snapshot', { source_dir: source }));
const singleScan = await capture('single-capability-scan', () => call(running, 'forma_scan_capabilities', { run_id: singleSnapshot.run_id }));
const singleId = singleScan.catalog.features[0].feature_id;
await capture('single-selection', () => call(running, 'forma_create_selection', { run_id: singleSnapshot.run_id, feature_ids: [singleId], permission_ceiling: { network: [], paths: [], credentials: [] }, transformation_mode: 'direct-source' }));
await capture('single-transformation-plan', () => call(running, 'forma_plan_transformation', { run_id: singleSnapshot.run_id, mode: 'direct-source' }));
const singleCandidate = await capture('single-candidate-build', () => call(running, 'forma_build_candidate', { run_id: singleSnapshot.run_id, package_name: 'aios-plugin-generated-single' }));
const singleStatic = await capture('single-static-validation', () => call(running, 'forma_validate_candidate', { run_id: singleSnapshot.run_id }));
assert.equal(singleStatic.validation_report.status, 'incomplete');
const singleBundle = JSON.parse(await readFile(singleCandidate.report_paths.candidate_bundle));
await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'install', singleBundle.internal_tarball_path, '--config.ignore-scripts=true', '--yes'], { cwd: candidateHome, env: candidateEnv });
let singleRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv });
await capture('single-candidate-install-tools', () => fetch(singleRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, [singleId]); assert.equal(value.worker_pid_distinct, true); return value; }));
const singleFeature = singleBundle.features[0];
await capture('single-candidate-call', () => callAt(singleRunning, '/candidate', singleFeature.name, sampleArgs(singleFeature)));
await capture('single-unselected-rejected', () => callExpectErrorAt(singleRunning, '/candidate', featureIds.find(id => id !== singleId), {}, /TOOL_NOT_ALLOWED/));
await singleRunning.stop('single-candidate-installed');
singleRunning = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv });
await capture('single-candidate-restart-tools', () => fetch(singleRunning.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, [singleId]); assert.equal(value.worker_pid_distinct, true); return value; }));
await capture('single-candidate-restart-call', () => callAt(singleRunning, '/candidate', singleFeature.name, sampleArgs(singleFeature)));
await singleRunning.stop('single-candidate-restarted');
await run(process.execPath, [dshBin, 'plugin', '--profile', 'candidate-test', 'remove', singleBundle.package_name, '--yes'], { cwd: candidateHome, env: candidateEnv });
const singleBaseline = await boot({ profileName: 'candidate-test', readyPrefix: 'FORMA_CANDIDATE_READY', shutdownPath: '/candidate/shutdown', homeEnv: candidateEnv });
await capture('single-candidate-uninstall-baseline', () => fetch(singleBaseline.origin + '/candidate/health', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()).then(value => { assert.deepEqual(value.tools, []); return value; }));
await singleBaseline.stop('single-candidate-removed');
const singleValidation = await capture('single-independent-validation', () => call(running, 'forma_validate_candidate', { run_id: singleSnapshot.run_id, acceptance_evidence: { 'candidate-install': true, 'candidate-call': true, 'candidate-restart': true, 'candidate-uninstall': true } }));
assert.equal(singleValidation.validation_report.status, 'passed');
const singleExport = await capture('single-plugin-repo-export', () => call(running, 'forma_export_plugin_repo', { run_id: singleSnapshot.run_id }));
const validation = await capture('independent-validation', () => call(running, 'forma_validate_candidate', { run_id: snapshot.run_id, acceptance_evidence: { 'candidate-install': true, 'candidate-call': true, 'candidate-restart': true, 'candidate-uninstall': true } }));
assert.equal(validation.validation_report.status, 'passed');
const exported = await capture('plugin-repo-export', () => call(running, 'forma_export_plugin_repo', { run_id: snapshot.run_id }));
assert.match(exported.artifact_digest, /^sha256:/);

for (const [label, dir] of [['gpl', resolve(fixtures, 'm1/repo-tool-gpl')], ['unknown', resolve(fixtures, 'm1/repo-tool-unknown')]]) {
  const snap = await call(running, 'forma_source_snapshot', { source_dir: dir });
  await call(running, 'forma_scan_capabilities', { run_id: snap.run_id });
  await call(running, 'forma_create_selection', { run_id: snap.run_id, feature_ids: [label === 'gpl' ? 'gpl_reverse' : 'count_lines'], permission_ceiling: { network: [], paths: [], credentials: [] }, transformation_mode: 'direct-source' });
  await call(running, 'forma_plan_transformation', { run_id: snap.run_id, mode: 'direct-source' });
  await capture(`${label}-blocked`, () => callExpectError(running, 'forma_build_candidate', { run_id: snap.run_id }, label === 'gpl' ? /LICENSE_REVIEW_PENDING|LICENSE_BLOCKED/ : /LICENSE_BLOCKED/));
}
await running.stop('installed');
running = await boot();
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
  const rejected = await boot({ expectReady: false });
  assert.equal(rejected.origin, null);
  assert.match(rejected.stderr(), /INTEGRITY_MISMATCH|RUNTIME_DIGEST_MISMATCH|PLUGIN_IDENTITY_MISMATCH/);
  await rejected.stop('tamper-' + file.replaceAll('/', '-'));
  await writeFile(path, bytes);
  const restored = await boot();
  const restoredHealth = await fetch(restored.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(restoredHealth.status, 200);
  assert.equal((await restoredHealth.json()).tools.length, 7);
  await restored.stop('restored-' + file.replaceAll('/', '-'));
  reports.push({ name: 'tamper-rejected:' + file, status: 'passed' });
}
running = await boot();
await running.stop('pre-remove');
await run(process.execPath, [dshBin, 'plugin', '--profile', 'forma-test', 'remove', 'aios-plugin-forma', '--yes'], { cwd: home, env });
const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
assert.deepEqual(after.dsh.profile.bundles, []);
assert.equal(after.dependencies?.['aios-plugin-forma'], undefined);
const baseline = await boot();
const baselineHealth = await fetch(baseline.origin + '/forma/plugin/health', { headers: { authorization: `Bearer ${token}` } });
assert.equal(baselineHealth.status, 200);
assert.deepEqual((await baselineHealth.json()).tools, []);
await baseline.stop('removed');
reports.push({ name: 'uninstall-baseline-restored', status: 'passed' });
await save('ValidationReport.json', { schema_version: 1, status: 'passed', run_id: snapshot.run_id, script_run_id: runId, checks: reports, dsh: '@deepseek-ai/dsh@0.1.3-alpha.2', cordis: '4.0.2', include: '1.0.7', node: process.versions.node, port: 0, dsh_home: home, evidence_dir: evidence, generated_artifact_digest: exported.artifact_digest, export_path: exported.plugin_repo_export_path, generated_candidates: [{ mode: 'multi-selection', artifact_digest: exported.artifact_digest, export_path: exported.plugin_repo_export_path }, { mode: 'single-selection', artifact_digest: singleExport.artifact_digest, export_path: singleExport.plugin_repo_export_path }], limitations: ['No GitHub/npm publish or production profile.', 'Worker process boundary is not an OS malicious-code sandbox.', 'OpenAPI candidate generation remains the legacy single-tool route; multi-selection is enabled for repo-function candidates.'] });
const publicPath = path => relative(root, path).split('\\').join('/');
await writeFile(join(root, 'evidence', 'latest-dsh-forma.json'), JSON.stringify({ run_id: snapshot.run_id, script_run_id: runId, status: 'passed', evidence_dir: publicPath(evidence), dsh_home: publicPath(home), artifact_digest: exported.artifact_digest, export_path: publicPath(exported.plugin_repo_export_path), generated_candidates: { multi: { artifact_digest: exported.artifact_digest, export_path: publicPath(exported.plugin_repo_export_path) }, single: { artifact_digest: singleExport.artifact_digest, export_path: publicPath(singleExport.plugin_repo_export_path) } } }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'passed', run_id: snapshot.run_id, script_run_id: runId, evidence_dir: evidence, artifact_digest: exported.artifact_digest, export_path: exported.plugin_repo_export_path }, null, 2));
if (baseline?.child?.pid) spawnSync('taskkill', ['/PID', String(baseline.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
process.exit(0);
