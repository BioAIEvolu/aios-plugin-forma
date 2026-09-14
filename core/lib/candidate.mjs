import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { digest, manifest, objectDigest } from './records.mjs';
import { findFeature, catalogHash } from './catalog.mjs';
import { validateSelection, selectionDigest } from './selection.mjs';
import { ACTUAL_LANGUAGE, TRANSPORT, TEMPLATE_VERSION, planDigest } from './plan.mjs';
import { requiredPermissions, assertPermissionSubset } from './permissions.mjs';
import { assertLicenseCleared, licenseReportDigest } from './license.mjs';
import { assertTransformationCleared, transformationPlanDigest } from './transformation.mjs';
import { classifySourceTrust } from './repo-source.mjs';

// Files hashed by runtime/host.mjs at boot; runtimeDigest must cover exactly this set.
const RUNTIME_FILES = ['capability.json', 'host.mjs', 'supervisor.mjs', 'worker.mjs', 'package.json'];

/**
 * M1.1 license/transformation gate shared by every candidate route.
 * Re-verifies the frozen digest chain (selection -> plan -> reports) and refuses
 * generation while a license or transformation review is pending/blocked.
 */
export function assertLicenseChain({ selection, plan, licenseReport, transformationPlan, reviewRecord } = {}) {
  if (selection.license_report_digest == null) return null;
  if (!licenseReport) throw new Error('LICENSE_REPORT_REQUIRED');
  if (licenseReportDigest(licenseReport) !== selection.license_report_digest) throw new Error('LICENSE_REPORT_DIGEST_MISMATCH');
  if (plan) {
    if (plan.license_report_digest !== selection.license_report_digest) throw new Error('LICENSE_REPORT_DIGEST_MISMATCH');
    if (plan.transformation_plan_digest !== transformationPlanDigest(transformationPlan)) throw new Error('TRANSFORMATION_PLAN_DIGEST_MISMATCH');
  }
  if (!transformationPlan) throw new Error('TRANSFORMATION_PLAN_REQUIRED');
  if (transformationPlan.mode !== selection.transformation_mode) throw new Error('TRANSFORMATION_MODE_MISMATCH');
  if (transformationPlan.license_report_digest !== selection.license_report_digest) throw new Error('LICENSE_REPORT_DIGEST_MISMATCH');
  assertLicenseCleared(licenseReport, { reviewRecord, planDigest: transformationPlanDigest(transformationPlan) });
  assertTransformationCleared(transformationPlan, { reviewRecord });
  return { licenseReport, transformationPlan };
}

/**
 * Resolve the package.json `license` field from the frozen license chain.
 * Never hardcoded: inherit/compatible-new-code carry the detected source SPDX;
 * separate-component and approved review-required use 'SEE LICENSE' unless the
 * independent review record names an approved output license. The B01 path
 * (no license chain) stays 'MIT' because that fixture is project-owned.
 */
export function resolveOutputLicense({ licenseReport = null, transformationPlan = null, reviewRecord = null } = {}) {
  if (!licenseReport) return 'MIT';
  const sourceSpdx = licenseReport.detected.find(item => item.scope === 'source' && item.spdx)?.spdx ?? null;
  switch (transformationPlan?.output_license_strategy) {
    case 'inherit':
    case 'compatible-new-code':
      return sourceSpdx ?? 'SEE LICENSE';
    case 'separate-component':
      return 'SEE LICENSE';
    case 'review-required':
      // Reachable only after assertLicenseChain accepted an independent record.
      if (reviewRecord?.approved_output_license) return reviewRecord.approved_output_license;
      return 'SEE LICENSE';
    default:
      throw new Error(`OUTPUT_LICENSE_STRATEGY_UNKNOWN:${transformationPlan?.output_license_strategy}`);
  }
}

/** Refuse a declaration which does not match the frozen report/plan/review chain. */
export function assertOutputLicenseConsistency({ packageLicense, licenseReport = null, transformationPlan = null, reviewRecord = null } = {}) {
  const expected = resolveOutputLicense({ licenseReport, transformationPlan, reviewRecord });
  if (packageLicense !== expected) throw new Error(`OUTPUT_LICENSE_MISMATCH:${packageLicense ?? 'missing'}!=${expected}`);
  return expected;
}

/** License deliverables written into every license-bound candidate. */
async function writeLicenseMaterials(candidateDir, { licenseReport, transformationPlan, sourceDir, reviewRecord = null, packageLicense }) {
  await mkdir(join(candidateDir, 'source-licenses'), { recursive: true });
  const licenseFile = licenseReport.evidence_refs.find(ref => /^(LICENSE|LICENCE|COPYING)/i.test(ref));
  if (licenseFile && sourceDir) await copyFile(join(sourceDir, licenseFile), join(candidateDir, 'source-licenses', 'LICENSE'));
  const noticeFile = licenseReport.evidence_refs.find(ref => /^NOTICE(\.[^/]*)?$/i.test(ref));
  if (noticeFile && sourceDir) await copyFile(join(sourceDir, noticeFile), join(candidateDir, 'source-licenses', 'NOTICE'));
  const notices = transformationPlan.notices ?? [];
  await writeFile(join(candidateDir, 'ATTRIBUTION.md'), [
    '# Attribution',
    '',
    `Source license: ${licenseReport.detected.find(item => item.scope === 'source' && item.spdx)?.spdx ?? 'see license-report.json'}`,
    `Transformation mode: ${transformationPlan.mode}`,
    `Output license strategy: ${transformationPlan.output_license_strategy}`,
    `Package license declaration: ${packageLicense}`,
    '',
    '## Original notices',
    ...(notices.length ? notices.map(line => `- ${line}`) : ['- (no NOTICE lines extracted)']),
    '',
    '## Review record',
    ...(reviewRecord
      ? [`- reviewer: ${reviewRecord.reviewer}`, `- reviewed_at: ${reviewRecord.reviewed_at}`, `- scope: ${reviewRecord.scope}`, `- decision: ${reviewRecord.decision}`, ...(reviewRecord.approved_output_license ? [`- approved_output_license: ${reviewRecord.approved_output_license}`] : [])]
      : ['- (none; status was clear without human review)']),
    '',
    'Legal notice: this package was assembled by an automated transformation. The classification of the transformation mode does not constitute a legal determination of derivative-work status.',
    '',
  ].join('\n'));
  await writeFile(join(candidateDir, 'source-licenses', 'DEPENDENCIES.md'), [
    '# Runtime dependency license closure',
    '',
    ...(licenseReport.dependency_closure?.length
      ? licenseReport.dependency_closure.map(entry => `- ${entry.name}@${entry.version}: ${entry.license ?? 'UNRESOLVED'} (${entry.evidence})`)
      : ['- (no runtime dependencies)']),
    '',
    `dependency_closure_digest: ${licenseReport.dependency_closure_digest}`,
    '',
  ].join('\n'));
  await writeFile(join(candidateDir, 'TRANSFORMATION.md'), [
    '# Transformation record',
    '',
    `mode: ${transformationPlan.mode}`,
    `source_language: ${transformationPlan.source_language}`,
    `implementation_language: ${transformationPlan.implementation_language}`,
    `actual_language: ${transformationPlan.actual_language}`,
    `review_status: ${transformationPlan.review_status}`,
    '',
    '## Source correspondence',
    ...(transformationPlan.source_correspondence?.length ? transformationPlan.source_correspondence.map(line => `- ${line}`) : ['- (none recorded)']),
    '',
  ].join('\n'));
  await writeFile(join(candidateDir, 'specs/license-report.json'), JSON.stringify(licenseReport, null, 2) + '\n');
  await writeFile(join(candidateDir, 'specs/transformation-plan.json'), JSON.stringify(transformationPlan, null, 2) + '\n');
  await writeFile(join(candidateDir, 'specs/license-review-record.json'), JSON.stringify(reviewRecord, null, 2) + '\n');
  await writeFile(join(candidateDir, 'specs/license-output.json'), JSON.stringify({
    schema_version: 1,
    package_license: packageLicense,
    output_license_strategy: transformationPlan.output_license_strategy,
    license_report_digest: licenseReportDigest(licenseReport),
    transformation_plan_digest: transformationPlanDigest(transformationPlan),
  }, null, 2) + '\n');
}

/** Generate the audited Node worker candidate from a frozen selection and its plan. */
export async function generateCandidate({ root, candidateDir, catalog, selection, plan, origin, timeoutMs = 1500, runtimeDir = join(root, 'runtime'), packageName = 'forma-m0-candidate', packageVersion = '0.0.1', peerDependencies = {}, licenseReport = null, transformationPlan = null, reviewRecord = null, sourceDir = null }) {
  validateSelection(catalog, selection);
  if (plan) {
    if (plan.selection_digest !== selectionDigest(selection)) throw new Error('PLAN_SELECTION_MISMATCH');
    if (planDigest(plan) !== plan.plan_digest) throw new Error('PLAN_DIGEST_MISMATCH');
  }
  const chain = assertLicenseChain({ selection, plan, licenseReport, transformationPlan, reviewRecord });
  // F1 gate: refuse to write any candidate bytes when the required permissions
  // exceed the frozen ceiling. An empty network ceiling grants nothing.
  const granted = requiredPermissions(catalog, selection, origin);
  assertPermissionSubset(selection.permission_ceiling, granted);
  const packageLicense = resolveOutputLicense({ licenseReport: chain?.licenseReport ?? null, transformationPlan: chain?.transformationPlan ?? null, reviewRecord });
  await mkdir(join(candidateDir, 'specs'), { recursive: true });
  const features = selection.selected_feature_ids.map(id => findFeature(catalog, id));
  const capabilities = features.map(feature => ({
    name: feature.feature_id,
    description: feature.description,
    method: feature.method,
    path: feature.path,
    input_schema: feature.input,
    output_schema: feature.output,
    errors: feature.errors,
    evidence: feature.evidence,
    permissions: { network: [origin + feature.path], paths: [], credentials: [] },
    actual_language: ACTUAL_LANGUAGE,
    runtime_version: process.versions.node,
    transport: TRANSPORT,
    template_version: TEMPLATE_VERSION,
  }));
  // The M1 host template consumes one capability.json; multi-selection stays recorded
  // in specs/features.json without exposing extra tools.
  // The legacy M1 candidate is one capability. The self-building Forma route
  // can freeze several repo functions; encode that set as a data-only array so
  // the audited Host can register one Supervisor per selected function.
  await writeFile(join(candidateDir, 'capability.json'), JSON.stringify(selection.multi_selection ? capabilities : capabilities[0], null, 2) + '\n');
  await writeFile(join(candidateDir, 'specs/features.json'), JSON.stringify({ schema_version: 1, selection_digest: selectionDigest(selection), plan_digest: plan?.plan_digest ?? null, ...(chain ? { license_report_digest: licenseReportDigest(chain.licenseReport), transformation_plan_digest: transformationPlanDigest(chain.transformationPlan) } : {}), features: capabilities }, null, 2) + '\n');
  for (const name of ['host.mjs', 'supervisor.mjs', 'worker.mjs']) await copyFile(join(runtimeDir, name), join(candidateDir, name));
  if (chain) await writeLicenseMaterials(candidateDir, { licenseReport: chain.licenseReport, transformationPlan: chain.transformationPlan, sourceDir, reviewRecord, packageLicense });
  await writeFile(join(candidateDir, 'package.json'), JSON.stringify({ name: packageName, version: packageVersion, type: 'module', license: packageLicense, main: './host.mjs', exports: { '.': './host.mjs', './package.json': './package.json' }, files: ['*.mjs', '*.json', 'README.md', 'ATTRIBUTION.md', 'TRANSFORMATION.md', 'cordis.patch.yml', 'specs/', 'source-licenses/'], peerDependencies, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n');
  assertOutputLicenseConsistency({ packageLicense, licenseReport: chain?.licenseReport ?? null, transformationPlan: chain?.transformationPlan ?? null, reviewRecord });
  const capabilityBytes = await readFile(join(candidateDir, 'capability.json'));
  const descriptorDigest = digest(capabilityBytes);
  const specsDigest = digest(await readFile(join(candidateDir, 'specs/features.json')));
  const runtimeHashes = [];
  for (const name of RUNTIME_FILES) runtimeHashes.push([name, digest(await readFile(join(candidateDir, name))).slice(7)]);
  const runtimeDigest = digest(JSON.stringify(runtimeHashes));
  await writeFile(join(candidateDir, 'cordis.patch.yml'), yaml.dump([{ insert: [{ id: 'forma-candidate', name: packageName, config: { origin, runtimeDigest, timeoutMs } }] }]));
  await writeFile(join(candidateDir, 'README.md'), [
    'Forma M1 selection-driven OpenAPI candidate. Actual language: TypeScript/JavaScript Host + Node Worker.',
    ...(chain ? ['', `Package license declaration: ${packageLicense} (output strategy: ${chain.transformationPlan.output_license_strategy}). See ATTRIBUTION.md and source-licenses/.`] : []),
    '',
  ].join('\n'));
  return { features: capabilities, descriptorDigest, specsDigest, runtimeDigest, fileManifest: await manifest(candidateDir), frozenSelectionDigest: selectionDigest(selection), catalogHash: catalogHash(catalog), packageLicense };
}

/**
 * M1.1 repo-tool candidate (direct-source route): the ORIGINAL source module is
 * copied verbatim into the candidate, license materials are attached, and the
 * repo host template registers exactly the one selected capability.
 */
export async function generateRepoCandidate({ root, candidateDir, catalog, selection, plan, sourceDir, runtimeDir = join(root, 'runtime'), packageName = 'forma-m0-candidate', packageVersion = '0.0.1', peerDependencies = {}, licenseReport, transformationPlan, reviewRecord = null, sourceSnapshot = null, timeoutMs = 1500, trustedRoots = [] }) {
  validateSelection(catalog, selection);
  if (plan) {
    if (plan.selection_digest !== selectionDigest(selection)) throw new Error('PLAN_SELECTION_MISMATCH');
    if (planDigest(plan) !== plan.plan_digest) throw new Error('PLAN_DIGEST_MISMATCH');
  }
  const chain = assertLicenseChain({ selection, plan, licenseReport, transformationPlan, reviewRecord });
  if (!chain) throw new Error('LICENSE_REPORT_REQUIRED: repo candidates always carry a frozen license chain');
  const trust = classifySourceTrust(sourceDir, trustedRoots);
  if (!['trusted-local-fixture', 'trusted-configured-source-root'].includes(trust)) throw new Error(`REPO_SOURCE_UNTRUSTED:${trust}`);
  if (sourceSnapshot?.trust && sourceSnapshot.trust !== trust) throw new Error('REPO_SOURCE_TRUST_MISMATCH');
  const granted = requiredPermissions(catalog, selection);
  assertPermissionSubset(selection.permission_ceiling, granted);
  await mkdir(join(candidateDir, 'specs'), { recursive: true });
  const features = selection.selected_feature_ids.map(id => findFeature(catalog, id));
  const capabilities = features.map(feature => ({
    name: feature.feature_id,
    kind: 'repo-function',
    description: feature.description,
    module: feature.module,
    export_name: feature.export_name,
    input_schema: feature.input,
    output_schema: feature.output,
    errors: feature.errors,
    evidence: feature.evidence,
    permissions: { network: [], paths: [], credentials: [] },
    actual_language: transformationPlan.actual_language,
    runtime_version: process.versions.node,
    template_version: 'repo-direct-source-v1',
  }));
  await writeFile(join(candidateDir, 'capability.json'), JSON.stringify(selection.multi_selection ? capabilities : capabilities[0], null, 2) + '\n');
  await writeFile(join(candidateDir, 'specs/features.json'), JSON.stringify({ schema_version: 1, selection_digest: selectionDigest(selection), plan_digest: plan?.plan_digest ?? null, license_report_digest: licenseReportDigest(chain.licenseReport), transformation_plan_digest: transformationPlanDigest(chain.transformationPlan), features: capabilities }, null, 2) + '\n');
  // direct-source: copy the original implementation files verbatim and record
  // the source -> candidate correspondence. Nothing is transpiled or rewritten.
  const correspondence = [];
  const modules = [...new Set(features.map(feature => feature.module))];
  for (const modulePath of modules) {
    const target = join(candidateDir, modulePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceDir, modulePath), target);
    correspondence.push(`${modulePath} -> ${modulePath} (verbatim, direct-source)`);
  }
  await writeFile(join(candidateDir, 'specs/source-correspondence.json'), JSON.stringify({ schema_version: 1, correspondence }, null, 2) + '\n');
  await copyFile(join(runtimeDir, 'host-repo-worker.mjs'), join(candidateDir, 'host.mjs'));
  await copyFile(join(runtimeDir, 'repo-supervisor.mjs'), join(candidateDir, 'repo-supervisor.mjs'));
  await copyFile(join(runtimeDir, 'repo-worker.mjs'), join(candidateDir, 'repo-worker.mjs'));
  const packageLicense = resolveOutputLicense({ licenseReport: chain.licenseReport, transformationPlan: chain.transformationPlan, reviewRecord });
  await writeLicenseMaterials(candidateDir, { licenseReport: chain.licenseReport, transformationPlan: chain.transformationPlan, sourceDir, reviewRecord, packageLicense });
  await writeFile(join(candidateDir, 'package.json'), JSON.stringify({ name: packageName, version: packageVersion, type: 'module', license: packageLicense, main: './host.mjs', exports: { '.': './host.mjs', './package.json': './package.json' }, files: ['*.mjs', '*.json', 'README.md', 'ATTRIBUTION.md', 'TRANSFORMATION.md', 'cordis.patch.yml', 'specs/', 'source-licenses/', 'src/'], peerDependencies, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n');
  assertOutputLicenseConsistency({ packageLicense, licenseReport: chain.licenseReport, transformationPlan: chain.transformationPlan, reviewRecord });
  const capabilityBytes = await readFile(join(candidateDir, 'capability.json'));
  const descriptorDigest = digest(capabilityBytes);
  const specsDigest = digest(await readFile(join(candidateDir, 'specs/features.json')));
  const runtimeHashes = [];
  for (const name of ['capability.json', 'host.mjs', 'repo-supervisor.mjs', 'repo-worker.mjs', 'package.json', 'specs/license-report.json', 'specs/transformation-plan.json', 'specs/license-review-record.json', 'specs/license-output.json', ...modules]) runtimeHashes.push([name, digest(await readFile(join(candidateDir, name))).slice(7)]);
  const runtimeDigest = digest(JSON.stringify(runtimeHashes));
  await writeFile(join(candidateDir, 'cordis.patch.yml'), yaml.dump([{ insert: [{ id: 'forma-candidate', name: packageName, config: { runtimeDigest, timeoutMs } }] }]));
  await writeFile(join(candidateDir, 'README.md'), [
    'Forma M1.1 repo-tool candidate (direct-source).',
    `Actual language: ${transformationPlan.actual_language} (source preserved).`,
    '',
    '## License and Attribution',
    '',
    `- Source license: ${chain.licenseReport.detected.find(item => item.scope === 'source' && item.spdx)?.spdx ?? 'see specs/license-report.json'}`,
    `- Package license declaration: ${packageLicense}`,
    `- Transformation mode: ${transformationPlan.mode}`,
    `- Output license strategy: ${transformationPlan.output_license_strategy}`,
    '- See ATTRIBUTION.md, TRANSFORMATION.md and source-licenses/.',
    '',
    'Legal notice: automated transformation; not a legal determination of derivative-work status.',
    '',
  ].join('\n'));
  return { features: capabilities, descriptorDigest, specsDigest, runtimeDigest, fileManifest: await manifest(candidateDir), frozenSelectionDigest: selectionDigest(selection), catalogHash: catalogHash(catalog), correspondence, packageLicense, template: 'repo-worker-v1' };
}
