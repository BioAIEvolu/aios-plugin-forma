import { objectDigest, deepFreeze } from './records.mjs';
import { licenseReportDigest } from './license.mjs';

/**
 * M1.1 TransformationPlan: exactly four transformation modes, mechanical
 * boundaries, no model-discretion labels.
 *
 *   direct-source          candidate keeps/patches the original implementation
 *   refactor-port          translation/rework derived from the original; the
 *                          executor provably read source (source_access_log non-empty)
 *   external-component     original project stays independent; adapter records
 *                          exact version/license/source-retrieval/protocol/materials
 *   clean-reimplementation two-phase isolation: analysis may read source and emit a
 *                          BehaviorSpec; the reimplementation phase may only read the
 *                          approved BehaviorSpec, public interfaces and acceptance
 *                          samples. An executor that read source can NEVER mark clean.
 *
 * Language rules: direct-source/external-component default to the source
 * language; refactor-port/clean-reimplementation default to TypeScript. A
 * default never impersonates an artifact: actual_language is resolved here and
 * verified again when the candidate is generated.
 */

export const TRANSFORMATION_MODES = ['direct-source', 'refactor-port', 'external-component', 'clean-reimplementation'];
export const SUPPORTED_IMPLEMENTATION_LANGUAGES = ['typescript', 'javascript'];

export function assertValidTransformationMode(mode) {
  if (!TRANSFORMATION_MODES.includes(mode)) throw new Error(`TRANSFORMATION_MODE_INVALID:${mode}`);
  return true;
}

/**
 * Resolve the implementation language.
 * choice: normalized { mode, requested_language, constraint } from the selection.
 * Returns { implementation_language, requested_language, fallback? }.
 */
export function resolveImplementationLanguage({ choice, mode, sourceLanguage }) {
  const requested = choice?.requested_language?.toLowerCase();
  const explicit = choice?.mode === 'explicit' && requested;
  let resolved;
  if (explicit) resolved = requested;
  else if (mode === 'direct-source' || mode === 'external-component') resolved = (sourceLanguage ?? 'javascript').toLowerCase();
  else resolved = 'typescript';
  if (SUPPORTED_IMPLEMENTATION_LANGUAGES.includes(resolved)) return { implementation_language: resolved, requested_language: requested ?? null };
  if (explicit && choice.constraint === 'required') {
    throw new Error(`LANGUAGE_UNSUPPORTED:${requested}: required language is not supported; actual support is limited to ${SUPPORTED_IMPLEMENTATION_LANGUAGES.join('/')}`);
  }
  const target = (mode === 'direct-source' || mode === 'external-component') ? (sourceLanguage ?? 'javascript').toLowerCase() : 'typescript';
  const fallbackTarget = SUPPORTED_IMPLEMENTATION_LANGUAGES.includes(target) ? target : 'typescript';
  return {
    implementation_language: fallbackTarget,
    requested_language: requested ?? null,
    fallback: { requested: requested ?? resolved, reason: `preferred language not supported in M1.1; fell back to ${fallbackTarget}` },
  };
}

function deriveOutputLicenseStrategy(report, mode) {
  if (report.status !== 'clear') return 'review-required';
  if (mode === 'direct-source') return 'inherit';
  if (mode === 'refactor-port') return 'compatible-new-code';
  if (mode === 'external-component') return 'separate-component';
  return 'review-required'; // clean-reimplementation always needs human confirmation of the isolation boundary
}

/**
 * Create a TransformationPlan bound to a LicenseReport digest.
 * isolation: { analysis_access_log, reimplementation_access_log } — the mechanical
 * clean/refactor discriminator. refactor-port REQUIRES a non-empty analysis log;
 * clean-reimplementation REQUIRES an empty reimplementation log and rejects when
 * the implementing executor read any original source file.
 */
export function createTransformationPlan({ licenseReport, mode, languageChoice, sourceLanguage = 'javascript', sourceSnapshot, notices = [], sourceCorrespondence = [], isolation, externalComponent }) {
  assertValidTransformationMode(mode);
  if (!licenseReport?.status) throw new Error('LICENSE_REPORT_REQUIRED');
  const reportDigest = licenseReportDigest(licenseReport);
  const analysisLog = isolation?.analysis_access_log ?? [];
  const reimplementationLog = isolation?.reimplementation_access_log ?? [];
  if (mode === 'refactor-port' && analysisLog.length === 0) {
    throw new Error('REFACTOR_SOURCE_ACCESS_REQUIRED: refactor-port must record the source files the executor actually read; without a source_access_log it cannot be distinguished from an unattributed rewrite');
  }
  if (mode === 'clean-reimplementation' && reimplementationLog.length > 0) {
    throw new Error(`CLEAN_SOURCE_ACCESS: the reimplementation phase read original source (${reimplementationLog.join(', ')}); this route can only be refactor-port or review_required, never clean-reimplementation`);
  }
  if (mode === 'external-component') {
    for (const key of ['version', 'license', 'source_retrieval', 'communication', 'distribution_materials']) {
      if (typeof externalComponent?.[key] !== 'string' || externalComponent[key].length === 0) throw new Error(`EXTERNAL_COMPONENT_RECORD_REQUIRED:${key}`);
    }
  }
  const language = resolveImplementationLanguage({ choice: languageChoice, mode, sourceLanguage });
  const strategy = deriveOutputLicenseStrategy(licenseReport, mode);
  const reviewStatus = strategy === 'review-required' ? 'pending' : 'not-required';
  const notes = [...notices];
  if (mode === 'refactor-port') notes.push('language change does not remove original license obligations; derivation stays tracked via source_correspondence and source_access_log');
  if (mode === 'external-component') notes.push('external invocation is not an automatic exemption: the component keeps its own license, source-offer and distribution obligations');
  const content = {
    schema_version: 1,
    mode,
    source_language: sourceLanguage,
    language_choice: languageChoice ?? null,
    host_language: 'javascript',
    implementation_language: language.implementation_language,
    requested_language: language.requested_language,
    ...(language.fallback ? { fallback: language.fallback } : {}),
    actual_language: language.implementation_language,
    license_report_digest: reportDigest,
    output_license_strategy: strategy,
    notices: notes,
    source_correspondence: sourceCorrespondence,
    source_access_log: analysisLog,
    reimplementation_access_log: reimplementationLog,
    ...(externalComponent ? { external_component: { ...externalComponent } } : {}),
    source_snapshot_digest: sourceSnapshot?.source_id ?? null,
    review_status: reviewStatus,
  };
  return deepFreeze({ ...content, plan_id: `transformation-plan-${objectDigest(content).slice(7, 23)}` });
}

export function transformationPlanDigest(plan) {
  return objectDigest(plan);
}

/** Generation gate for the transformation side: pending review never generates. */
export function assertTransformationCleared(plan, { reviewRecord } = {}) {
  if (!plan) throw new Error('TRANSFORMATION_PLAN_REQUIRED');
  if (plan.review_status === 'not-required') return true;
  if (plan.review_status === 'rejected') throw new Error('TRANSFORMATION_REVIEW_REJECTED');
  if (reviewRecord && reviewRecord.decision === 'approved' && reviewRecord.transformation_plan_digest === transformationPlanDigest(plan)) return true;
  throw new Error(`TRANSFORMATION_REVIEW_PENDING:${plan.mode}: review_status is pending and no independent LicenseReviewRecord approves this exact plan`);
}
