import { readFile } from 'node:fs/promises';
import { objectDigest, deepFreeze } from './records.mjs';
import { catalogHash, findFeature } from './catalog.mjs';
import { assertValidCeiling } from './permissions.mjs';

const DEFAULT_LANGUAGE = { mode: 'auto', constraint: 'preferred', host_source_language: 'javascript' };
const SUPPORTED_TARGET = 'forma-test';
const LANGUAGE_MODES = ['auto', 'preserve-source', 'explicit'];
const LANGUAGE_CONSTRAINTS = ['preferred', 'required'];
const TRANSFORMATION_MODES = ['direct-source', 'refactor-port', 'external-component', 'clean-reimplementation'];

function assertValidBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new Error('SELECTION_BUDGET_INVALID');
  for (const [key, value] of Object.entries(budget)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`SELECTION_BUDGET_INVALID:${key}`);
  }
}

/**
 * Normalize the language choice BEFORE any digest is computed.
 * `requested_language` is the canonical field; the M1 legacy input name
 * `requested_implementation_language` is folded into it. Both present with
 * different values is an ambiguity error, never a silent pick.
 */
export function normalizeLanguageChoice(choice) {
  if (choice === undefined) return undefined;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('LANGUAGE_CHOICE_INVALID');
  const normalized = { ...choice };
  const canonical = normalized.requested_language;
  const legacy = normalized.requested_implementation_language;
  if (legacy !== undefined) {
    if (canonical !== undefined && canonical !== legacy) throw new Error(`LANGUAGE_CHOICE_AMBIGUOUS: requested_language (${canonical}) conflicts with requested_implementation_language (${legacy})`);
    normalized.requested_language = legacy;
    delete normalized.requested_implementation_language;
  }
  if (!LANGUAGE_MODES.includes(normalized.mode)) throw new Error('LANGUAGE_CHOICE_INVALID:mode');
  if (!LANGUAGE_CONSTRAINTS.includes(normalized.constraint)) throw new Error('LANGUAGE_CHOICE_INVALID:constraint');
  if (normalized.requested_language !== undefined && typeof normalized.requested_language !== 'string') throw new Error('LANGUAGE_CHOICE_INVALID:requested_language');
  if (normalized.host_source_language !== undefined && !['typescript', 'javascript'].includes(normalized.host_source_language)) throw new Error('LANGUAGE_CHOICE_INVALID:host_source_language');
  return normalized;
}

function assertValidLicenseBinding(selection) {
  if (selection.license_report_digest !== undefined && selection.license_report_digest !== null) {
    if (typeof selection.license_report_digest !== 'string' || !selection.license_report_digest.startsWith('sha256:')) throw new Error('LICENSE_REPORT_DIGEST_INVALID');
  }
  if (selection.transformation_mode !== undefined && selection.transformation_mode !== null) {
    if (!TRANSFORMATION_MODES.includes(selection.transformation_mode)) throw new Error(`TRANSFORMATION_MODE_INVALID:${selection.transformation_mode}`);
  }
  // The binding is atomic: a license digest without a chosen route (or the
  // reverse) is a half-made decision and must not freeze.
  if ((selection.license_report_digest == null) !== (selection.transformation_mode == null)) throw new Error('LICENSE_BINDING_INCOMPLETE');
}

export function validateSelection(catalog, selection) {
  if (!selection || selection.schema_version !== 1) throw new Error('SELECTION_SCHEMA_INVALID');
  if (selection.catalog_hash !== catalogHash(catalog)) throw new Error('CATALOG_HASH_MISMATCH');
  const ids = selection.selected_feature_ids;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('SELECTION_FEATURES_INVALID');
  if (ids.length > 1 && selection.multi_selection !== true) throw new Error('SELECTION_MULTI_UNSUPPORTED');
  for (const id of ids) {
    const feature = findFeature(catalog, id);
    if (!feature) throw new Error(`FEATURE_NOT_FOUND:${id}`);
    if (selection.feature_spec_digests?.[id] !== feature.spec_digest) throw new Error(`FEATURE_SPEC_DIGEST_MISMATCH:${id}`);
  }
  // Value validation: only what this prototype actually supports may pass.
  if (selection.target !== SUPPORTED_TARGET) throw new Error(`SELECTION_TARGET_UNSUPPORTED:${selection.target}`);
  if (typeof selection.actor !== 'string' || selection.actor.length === 0) throw new Error('SELECTION_ACTOR_INVALID');
  if (typeof selection.submission_ref !== 'string' || selection.submission_ref.length === 0) throw new Error('SELECTION_SUBMISSION_REF_INVALID');
  if (!Number.isInteger(selection.revision) || selection.revision < 1) throw new Error('SELECTION_REVISION_INVALID');
  assertValidCeiling(selection.permission_ceiling);
  assertValidBudget(selection.budget);
  if (selection.language_choice !== undefined) {
    const normalized = normalizeLanguageChoice(selection.language_choice);
    if (JSON.stringify(normalized) !== JSON.stringify(selection.language_choice)) throw new Error('LANGUAGE_CHOICE_NOT_NORMALIZED');
  }
  assertValidLicenseBinding(selection);
  return true;
}

export function freezeSelection(catalog, selectedFeatureIds, options = {}) {
  const ids = [...new Set(selectedFeatureIds)].sort();
  if (ids.length > 1 && options.multi_selection !== true) throw new Error('SELECTION_MULTI_UNSUPPORTED');
  const features = ids.map(id => findFeature(catalog, id));
  if (features.some(feature => !feature)) throw new Error(`FEATURE_NOT_FOUND:${ids.find((id, i) => !features[i])}`);
  // Deep copies: the frozen spec must not share nested references with caller-owned options.
  const selection = {
    schema_version: 1,
    catalog_hash: catalogHash(catalog),
    selected_feature_ids: ids,
    feature_spec_digests: Object.fromEntries(features.map(feature => [feature.feature_id, feature.spec_digest])),
    target: options.target ?? 'forma-test',
    permission_ceiling: structuredClone(options.permission_ceiling ?? { network: [], paths: [], credentials: [] }),
    budget: structuredClone(options.budget ?? { model_tokens: 0 }),
    actor: options.actor ?? 'local-user',
    submission_ref: options.submission_ref ?? `forma-selection-${objectDigest({ ids, actor: options.actor ?? 'local-user' }).slice(7, 23)}`,
    revision: options.revision ?? 1,
    ...(options.multi_selection === true ? { multi_selection: true } : {}),
    language_choice: normalizeLanguageChoice(structuredClone(options.language_choice ?? DEFAULT_LANGUAGE)),
    ...(options.license_report_digest !== undefined || options.transformation_mode !== undefined
      ? { license_report_digest: options.license_report_digest ?? null, transformation_mode: options.transformation_mode ?? null }
      : {}),
  };
  validateSelection(catalog, selection);
  return deepFreeze(selection);
}

export function selectionDigest(selection) { return objectDigest(selection); }

/**
 * Read a persisted SelectionSpec and re-validate it against the current catalog.
 * expectedDigest is REQUIRED: the digest recorded by the trusted submission entry.
 * The hash carried by the file under validation is never treated as authoritative.
 */
export async function loadSelection(file, catalog, { expectedDigest } = {}) {
  if (typeof expectedDigest !== 'string' || !expectedDigest.startsWith('sha256:')) throw new Error('EXPECTED_SELECTION_DIGEST_REQUIRED');
  const selection = JSON.parse(await readFile(file, 'utf8'));
  validateSelection(catalog, selection);
  if (selectionDigest(selection) !== expectedDigest) throw new Error('SELECTION_DIGEST_MISMATCH');
  return deepFreeze(selection);
}

/** Idempotency state transition for repeated submissions. */
export function idempotencyResult(existing, selection) {
  const digest = selectionDigest(selection);
  if (!existing || existing.selection_digest !== digest) return { action: 'new-attempt', selection_digest: digest };
  if (existing.status === 'ACTIVE') return { action: 'return-existing', delivery_ref: existing.delivery_ref };
  if (existing.status === 'BUILDING' || existing.status === 'VALIDATING') return { action: 'in-progress', attempt_ref: existing.attempt_ref };
  if (existing.status === 'INSTALLING') return { action: 'reconcile-required', attempt_ref: existing.attempt_ref, reason: 'install outcome unconfirmed; refusing automatic retry of unknown side effects' };
  if (existing.status === 'FAILED' || existing.status === 'ROLLED_BACK') return { action: 'new-attempt', attempt_ref: `${existing.attempt_ref ?? 'attempt'}-retry`, selection_digest: digest };
  throw new Error(`SUBMISSION_STATUS_UNKNOWN:${existing.status}`);
}
