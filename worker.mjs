import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, lstat, realpath, copyFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const rawCoreRoot = process.env.FORMA_INTERNAL_CORE_ROOT;
const coreRoot = resolve(rawCoreRoot || '.');
const workRoot = resolve(process.env.FORMA_WORK_ROOT || '');
const parsedSourceRoots = JSON.parse(process.env.FORMA_SOURCE_ROOTS || '[]');
const sourceRoots = (Array.isArray(parsedSourceRoots) ? parsedSourceRoots.flat() : []).filter(root => typeof root === 'string').map(root => resolve(root));
const parsedReviewedRoots = JSON.parse(process.env.FORMA_REVIEWED_SOURCE_ROOTS || '[]');
const reviewedSourceRoots = (Array.isArray(parsedReviewedRoots) ? parsedReviewedRoots.flat() : []).filter(root => typeof root === 'string').map(root => resolve(root));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const runs = new Map();
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${requireSep()}`) && !isAbsolute(rel));
}
function requireSep() { return process.platform === 'win32' ? '\\' : '/'; }
async function assertSourcePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new Error('SOURCE_PATH_INVALID');
  const target = resolve(value);
  if (!sourceRoots.some(root => within(root, target))) throw new Error('SOURCE_PATH_OUTSIDE_ALLOWED_ROOT');
  const entry = await lstat(target).catch(error => { throw new Error(`SOURCE_PATH_INVALID:${error.code}`); });
  if (entry.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REJECTED');
  const [realTarget, ...realRoots] = await Promise.all([realpath(target), ...sourceRoots.map(root => realpath(root).catch(() => root))]);
  if (!realRoots.some(root => within(root, realTarget))) throw new Error('SOURCE_PATH_OUTSIDE_ALLOWED_ROOT');
  return target;
}
async function assertWorkPath(value, run) {
  if (!run) throw new Error('RUN_REQUIRED');
  const target = resolve(value);
  if (!within(run.dir, target) || target === resolve(run.dir)) throw new Error('WORK_PATH_OUTSIDE_JOB');
  const entry = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (entry?.isSymbolicLink()) throw new Error('WORK_SYMLINK_REJECTED');
  const parent = await realpath(dirname(target)).catch(() => dirname(target));
  if (!within(run.dir, parent)) throw new Error('WORK_PATH_OUTSIDE_JOB');
  return target;
}
function safePackageName(value) {
  const name = value ?? `aios-plugin-generated-${randomUUID().slice(0, 8)}`;
  if (typeof name !== 'string' || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.length > 96) throw new Error('PACKAGE_NAME_INVALID');
  return name;
}
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
async function save(run, name, value) {
  const path = join(run.dir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}
async function loadCore() {
  if (!rawCoreRoot) throw new Error('CORE_ROOT_REQUIRED');
  const from = name => import(pathToFileURL(join(coreRoot, 'lib', name)).href);
  const [records, repo, license, selection, transformation, plan, candidate, validation, catalog] = await Promise.all([
    from('records.mjs'), from('repo-source.mjs'), from('license.mjs'), from('selection.mjs'),
    from('transformation.mjs'), from('plan.mjs'), from('candidate.mjs'), from('validation.mjs'), from('catalog.mjs'),
  ]);
  return { ...records, ...repo, ...license, ...selection, ...transformation, ...plan, ...candidate, ...validation, ...catalog };
}
const core = await loadCore();
send({ type: 'ready', protocol: 1, worker: 'forma-core', pid: process.pid });

async function getRun(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error('RUN_NOT_FOUND');
  return run;
}
async function createRun() {
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID().slice(0, 8);
  const dir = join(workRoot, runId);
  await mkdir(dir, { recursive: true });
  const run = { run_id: runId, dir, created_at: new Date().toISOString() };
  runs.set(runId, run);
  return run;
}
async function captureSource(args) {
  const sourceDir = await assertSourcePath(args.source_dir);
  const run = args.run_id ? await getRun(args.run_id) : await createRun();
  const snapshot = await core.createRepoSnapshot(sourceDir, { canonicalUri: args.canonical_uri ?? sourceDir, trustedRoots: reviewedSourceRoots });
  const licenseReport = await core.scanLicense(sourceDir, snapshot);
  run.source_dir = sourceDir;
  run.snapshot = snapshot;
  run.licenseReport = licenseReport;
  const snapshotPath = await save(run, 'SourceSnapshot.json', snapshot);
  const licensePath = await save(run, 'LicenseReport.json', licenseReport);
  return { run, response: { schema_version: 1, run_id: run.run_id, source_snapshot: snapshot, license_report: licenseReport, report_paths: { source_snapshot: snapshotPath, license_report: licensePath }, artifact_digest: core.objectDigest({ snapshot, licenseReport }) } };
}
async function sourceSnapshot(args) {
  return (await captureSource(args)).response;
}
async function scanCapabilities(args) {
  const run = args.run_id ? await getRun(args.run_id) : (await captureSource(args)).run;
  const sourceDir = await assertSourcePath(args.source_dir ?? run.source_dir);
  if (run.source_dir && resolve(run.source_dir) !== sourceDir) throw new Error('SOURCE_RUN_MISMATCH');
  let catalog;
  const openapiPath = join(sourceDir, args.openapi_file ?? 'openapi.json');
  try {
    const api = JSON.parse(await readFile(openapiPath, 'utf8'));
    catalog = core.buildFeatureCatalog(api, { sourceDigest: run.snapshot.source_id, openapiFile: args.openapi_file ?? 'openapi.json' });
  } catch (error) {
    if (error.code && !['ENOENT', 'EISDIR'].includes(error.code)) throw error;
    catalog = await core.buildRepoFeatureCatalog(sourceDir, { sourceDigest: run.snapshot.source_id });
  }
  run.catalog = catalog;
  const catalogPath = await save(run, 'FeatureCatalog.json', catalog);
  return { schema_version: 1, run_id: run.run_id, source_digest: run.snapshot.source_id, catalog, report_path: catalogPath, artifact_digest: catalog.catalog_hash };
}
async function createSelection(args) {
  const run = await getRun(args.run_id);
  if (!run.catalog) await scanCapabilities({ run_id: run.run_id, source_dir: run.source_dir });
  const ids = args.feature_ids ?? args.selected_feature_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 16) throw new Error('SELECTION_FEATURES_INVALID');
  const selection = core.freezeSelection(run.catalog, ids, {
    target: args.target ?? 'forma-test', actor: args.actor ?? 'dsh-user', submission_ref: args.submission_ref ?? `forma-${run.run_id}`,
    revision: args.revision ?? 1, multi_selection: ids.length > 1, permission_ceiling: args.permission_ceiling ?? { network: [], paths: [], credentials: [] },
    budget: args.budget ?? { model_tokens: 0 }, language_choice: args.language_choice,
    license_report_digest: args.license_report_digest ?? core.licenseReportDigest(run.licenseReport), transformation_mode: args.transformation_mode ?? 'direct-source',
  });
  run.selection = selection;
  const path = await save(run, 'SelectionSpec.json', selection);
  return { schema_version: 1, run_id: run.run_id, selection, selection_digest: core.selectionDigest(selection), report_path: path };
}
async function planTransformation(args) {
  const run = await getRun(args.run_id);
  if (!run.snapshot || !run.catalog) throw new Error('SNAPSHOT_AND_CATALOG_REQUIRED');
  const mode = args.mode ?? run.selection?.transformation_mode ?? 'direct-source';
  const languageChoice = args.language_choice ?? run.selection?.language_choice;
  const plan = core.createTransformationPlan({ licenseReport: run.licenseReport, mode, languageChoice, sourceLanguage: args.source_language ?? 'javascript', sourceSnapshot: run.snapshot, notices: args.notices ?? [], sourceCorrespondence: args.source_correspondence ?? [], isolation: args.isolation, externalComponent: args.external_component });
  run.transformationPlan = plan;
  const path = await save(run, 'TransformationPlan.json', plan);
  return { schema_version: 1, run_id: run.run_id, transformation_plan: plan, transformation_plan_digest: core.transformationPlanDigest(plan), report_path: path };
}
async function buildCandidate(args) {
  const run = await getRun(args.run_id);
  if (!run.selection || !run.catalog || !run.licenseReport) throw new Error('SELECTION_CATALOG_LICENSE_REQUIRED');
  await core.verifyManifest(run.source_dir, run.snapshot.file_manifest);
  if (!run.transformationPlan) await planTransformation({ run_id: run.run_id, mode: run.selection.transformation_mode, language_choice: run.selection.language_choice });
  const plan = core.createPluginPlan({ catalog: run.catalog, selection: run.selection, template: args.template ?? 'repo-worker-v1', licenseReport: run.licenseReport, transformationPlan: run.transformationPlan });
  const candidateDir = await assertWorkPath(args.candidate_dir ?? join(run.dir, 'candidate'), run);
  const packageName = safePackageName(args.package_name);
  await rm(candidateDir, { recursive: true, force: true });
  const generated = await core.generateRepoCandidate({ root: coreRoot, candidateDir, catalog: run.catalog, selection: run.selection, plan, sourceDir: run.source_dir, trustedRoots: reviewedSourceRoots, runtimeDir: join(coreRoot, 'runtime'), packageName, packageVersion: args.package_version ?? '0.1.0', peerDependencies: { '@deepseek-ai/cordis': '4.0.2', '@deepseek-ai/dsh-tools': '0.1.3-alpha.2', '@deepseek-ai/schemastery': '3.18.2' }, licenseReport: run.licenseReport, transformationPlan: run.transformationPlan, sourceSnapshot: run.snapshot, timeoutMs: args.timeout_ms ?? 1500 });
  const candidate = { schema_version: 1, ...generated, package_name: packageName, package_dir: candidateDir, plan_digest: plan.plan_digest, specs_digest: generated.specsDigest, descriptor_digest: generated.descriptorDigest, artifact_digest: core.objectDigest(generated.fileManifest), acceptance_suite_digest: core.objectDigest({ checks: ['candidate-manifest', 'license-chain', 'package-metadata'] }) };
  run.plan = plan; run.candidate = candidate; run.candidateDir = candidateDir;
  const planPath = await save(run, 'PluginPlan.json', plan);
  const candidatePath = await save(run, 'CandidateBundle.json', candidate);
  return { schema_version: 1, run_id: run.run_id, plugin_plan: plan, candidate_bundle: candidate, report_paths: { plugin_plan: planPath, candidate_bundle: candidatePath }, artifact_digest: candidate.artifact_digest };
}
async function validateCandidate(args) {
  const run = await getRun(args.run_id);
  if (!run.candidate || !run.plan) throw new Error('CANDIDATE_REQUIRED');
  const actualManifest = await core.manifest(run.candidateDir);
  if (core.objectDigest(actualManifest) !== core.objectDigest(run.candidate.fileManifest)) throw new Error('CANDIDATE_CHANGED');
  const internalDir = await assertWorkPath(join(run.dir, '.staging'), run);
  await mkdir(internalDir, { recursive: true });
  const packed = await runPack(run.candidateDir, internalDir);
  const internalTarball = resolve(internalDir, packed.filename);
  const internalDigest = digest(await readFile(internalTarball));
  run.candidate.artifact_digest = internalDigest;
  run.candidate.internal_tarball_path = internalTarball;
  run.candidate.internal_tarball_digest = internalDigest;
  await save(run, 'CandidateBundle.json', run.candidate);
  const acceptance = args.acceptance_evidence;
  const acceptanceChecks = ['candidate-install', 'candidate-call', 'candidate-restart', 'candidate-uninstall'].map(name => ({ name, status: acceptance?.[name] === true ? 'passed' : 'skipped', evidence: acceptance?.[name] === true ? { supplied: true } : { supplied: false, reason: 'independent disposable DSH evidence required' } }));
  const checks = [
    { name: 'candidate-manifest', status: 'passed', evidence: { files: actualManifest.length } },
    { name: 'license-chain', status: run.licenseReport.status === 'clear' ? 'passed' : 'failed', evidence: { status: run.licenseReport.status } },
    { name: 'package-metadata', status: 'passed', evidence: { package_dir: run.candidateDir } },
    ...acceptanceChecks,
  ];
  const report = core.createValidationReport({ catalog: run.catalog, selection: run.selection, plan: run.plan, candidate: run.candidate, checks, requiredChecks: ['candidate-manifest', 'license-chain', 'package-metadata', ...acceptanceChecks.map(check => check.name)], actualLanguage: run.transformationPlan?.actual_language });
  run.validation = report;
  const path = await save(run, 'ValidationReport.json', report);
  return { schema_version: 1, run_id: run.run_id, validation_report: report, report_path: path, artifact_digest: run.candidate.artifact_digest };
}
function runPack(candidateDir, destination) {
  return new Promise((resolvePromise, reject) => {
    const npmArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', destination];
    const executable = process.env.FORMA_NPM_EXEC_PATH ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const args = process.env.FORMA_NPM_EXEC_PATH ? [process.env.FORMA_NPM_EXEC_PATH, ...npmArgs] : npmArgs;
    // npm pack is a fixed, --ignore-scripts packaging helper. Clear inherited
    // Node permission flags for that helper because npm's own installation
    // tree lives outside the Forma-managed roots; no package lifecycle script
    // is allowed to run here.
    const child = spawn(executable, args, { cwd: candidateDir, shell: false, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 128 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 64 * 1024) child.kill(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise(JSON.parse(stdout)[0]) : reject(new Error(`PACK_FAILED:${stderr.slice(-1000)}`)));
  });
}
async function exportPluginRepo(args) {
  const run = await getRun(args.run_id);
  if (!run.candidateDir) throw new Error('CANDIDATE_REQUIRED');
  if (!run.validation || run.validation.status !== 'passed' || !run.candidate.internal_tarball_path) throw new Error('EXPORT_REQUIRES_PASSED_VALIDATION');
  if (run.validation.artifact_digest !== run.candidate.internal_tarball_digest) throw new Error('EXPORT_VALIDATION_DIGEST_MISMATCH');
  const exportDir = await assertWorkPath(args.export_dir ?? join(run.dir, 'export'), run);
  await mkdir(exportDir, { recursive: true });
  const filename = run.candidate.internal_tarball_path.split(/[\\/]/).pop();
  const tarball = resolve(exportDir, filename);
  await copyFile(run.candidate.internal_tarball_path, tarball);
  const bytes = await readFile(tarball);
  const artifactDigest = digest(bytes);
  run.candidate.artifact_digest = artifactDigest;
  run.candidate.export_path = tarball;
  await save(run, 'CandidateBundle.json', run.candidate);
  return { schema_version: 1, run_id: run.run_id, artifact_digest: artifactDigest, plugin_repo_source_dir: run.candidateDir, plugin_repo_export_path: tarball, package: { filename, size: bytes.length } }; 
}
const handlers = { forma_source_snapshot: sourceSnapshot, forma_scan_capabilities: scanCapabilities, forma_create_selection: createSelection, forma_plan_transformation: planTransformation, forma_build_candidate: buildCandidate, forma_validate_candidate: validateCandidate, forma_export_plugin_repo: exportPluginRepo };

lines.on('line', line => {
  if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) { send({ type: 'fatal', error: 'REQUEST_TOO_LARGE' }); process.exitCode = 2; lines.close(); return; }
  let message;
  try { message = JSON.parse(line); } catch { send({ type: 'fatal', error: 'PROTOCOL_JSON_INVALID' }); process.exitCode = 2; lines.close(); return; }
  if (message.type === 'shutdown') { send({ type: 'stopped' }); lines.close(); setImmediate(() => process.exit(0)); return; }
  if (message.type !== 'call' || message.protocol !== 1 || typeof message.id !== 'string' || !handlers[message.tool]) { send({ type: 'result', id: message.id, error: 'DTO_NOT_ALLOWED' }); return; }
  Promise.resolve().then(() => handlers[message.tool](message.arguments ?? {})).then(value => {
    const encoded = JSON.stringify(value ?? null);
    if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) send({ type: 'result', id: message.id, error: 'RESULT_TOO_LARGE' });
    else send({ type: 'result', id: message.id, value });
  }, error => send({ type: 'result', id: message.id, error: String(error?.message ?? error).slice(0, 512) }));
});
