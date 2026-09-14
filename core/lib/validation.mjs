import { validateSelection, selectionDigest } from './selection.mjs';
import { ACTUAL_LANGUAGE } from './plan.mjs';

/**
 * Build a validation report bound to trusted frozen inputs only: catalog, frozen
 * selection, plan and candidate/acceptance digests. Candidate package bytes
 * (including its specs/features.json) are never consulted to decide the outcome.
 * A report can only be 'passed' when every check passed AND the executed checks
 * cover the entry's required set; empty, skipped, missing or unexecuted results
 * never count as passed.
 */
export function createValidationReport({ catalog, selection, plan, candidate, checks = [], requiredChecks = [], actualLanguage = ACTUAL_LANGUAGE }) {
  validateSelection(catalog, selection);
  if (!plan?.plan_digest) throw new Error('VALIDATION_INPUT_REQUIRED:plan_digest');
  if (plan.selection_digest !== selectionDigest(selection)) throw new Error('PLAN_SELECTION_MISMATCH');
  for (const key of ['artifact_digest', 'specs_digest', 'acceptance_suite_digest']) {
    if (typeof candidate?.[key] !== 'string' || !candidate[key].startsWith('sha256:')) throw new Error(`VALIDATION_INPUT_REQUIRED:${key}`);
  }
  for (const check of checks) {
    if (!check || typeof check.name !== 'string' || !['passed', 'failed', 'skipped'].includes(check.status)) throw new Error('VALIDATION_CHECK_INVALID');
  }
  const executed = new Set(checks.map(check => check.name));
  const missingRequired = requiredChecks.filter(name => !executed.has(name));
  let status = 'passed';
  if (checks.length === 0 || checks.some(check => check.status === 'skipped') || missingRequired.length > 0) status = 'incomplete';
  if (checks.some(check => check.status === 'failed')) status = 'failed';
  return {
    schema_version: 1,
    selection_digest: selectionDigest(selection),
    catalog_hash: selection.catalog_hash,
    feature_spec_digests: { ...selection.feature_spec_digests },
    plan_digest: plan.plan_digest,
    ...(selection.license_report_digest != null ? { license_report_digest: selection.license_report_digest } : {}),
    ...(plan.license_report_digest ? { transformation_plan_digest: plan.transformation_plan_digest, transformation_mode: selection.transformation_mode } : {}),
    ...(candidate.package_license ?? candidate.license ? { package_license: candidate.package_license ?? candidate.license } : {}),
    artifact_digest: candidate.artifact_digest,
    specs_digest: candidate.specs_digest,
    acceptance_suite_digest: candidate.acceptance_suite_digest,
    required_checks: [...requiredChecks],
    missing_required_checks: missingRequired,
    actual_language: actualLanguage,
    checks: checks.map(check => ({ ...check })),
    status,
  };
}
