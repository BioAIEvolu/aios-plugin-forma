import { objectDigest, deepFreeze } from './records.mjs';
import { findFeature } from './catalog.mjs';
import { validateSelection, selectionDigest } from './selection.mjs';
import { licenseReportDigest } from './license.mjs';
import { transformationPlanDigest, resolveImplementationLanguage } from './transformation.mjs';

/** M1 actual adapter reality: only a TS/JS Host + Node Worker template is verified. */
export const ACTUAL_LANGUAGE = 'TypeScript/JavaScript Host + Node Worker';
export const TRANSPORT = 'HTTP loopback via Worker Gateway';
export const TEMPLATE_VERSION = 'fixed-openapi-get-v1';
export const SUPPORTED_IMPLEMENTATION_LANGUAGES = ['typescript', 'javascript'];

function resolveLanguage(choice, { transformationPlan } = {}) {
  if (transformationPlan) {
    // M1.1 path: the transformation plan owns the language decision; the plugin
    // plan records it verbatim. A default never impersonates an artifact.
    const language = {
      language_choice: choice ?? null,
      transformation_mode: transformationPlan.mode,
      host_language: transformationPlan.host_language,
      implementation_language: transformationPlan.implementation_language,
      actual_language: transformationPlan.actual_language,
      runtime_version: process.versions.node,
    };
    if (transformationPlan.fallback) language.fallback = transformationPlan.fallback;
    return language;
  }
  const language = {
    language_choice: choice ?? null,
    actual_language: ACTUAL_LANGUAGE,
    runtime_version: process.versions.node,
    transport: TRANSPORT,
    template_version: TEMPLATE_VERSION,
  };
  const requested = choice?.requested_language?.toLowerCase();
  if (!requested || SUPPORTED_IMPLEMENTATION_LANGUAGES.includes(requested)) return language;
  if (choice.constraint === 'required') {
    throw new Error(`LANGUAGE_UNSUPPORTED:${requested}: required language is not supported; actual support is limited to ${ACTUAL_LANGUAGE} (${SUPPORTED_IMPLEMENTATION_LANGUAGES.join('/')})`);
  }
  language.fallback = { requested, reason: `preferred language not supported in M1; fell back to ${ACTUAL_LANGUAGE}` };
  return language;
}

/**
 * Derive a PluginPlan from a frozen SelectionSpec.
 * Only selected features enter the plan; unselected catalog entries must not leak
 * into candidate tools, the Host patch or the Worker capability set.
 *
 * M1.1 digest chain: when the selection carries a license binding, the plan
 * re-verifies the LicenseReport and TransformationPlan digests and records both
 * `license_report_digest` and `transformation_plan_digest` inside the digest
 * input, so plan_digest covers the license/transformation decision too.
 */
export function createPluginPlan({ catalog, selection, template = TEMPLATE_VERSION, licenseReport = null, transformationPlan = null }) {
  validateSelection(catalog, selection);
  if (selection.license_report_digest != null) {
    if (!licenseReport) throw new Error('LICENSE_REPORT_REQUIRED');
    if (licenseReportDigest(licenseReport) !== selection.license_report_digest) throw new Error('LICENSE_REPORT_DIGEST_MISMATCH');
    if (!transformationPlan) throw new Error('TRANSFORMATION_PLAN_REQUIRED');
    if (transformationPlan.mode !== selection.transformation_mode) throw new Error('TRANSFORMATION_MODE_MISMATCH');
    if (transformationPlan.license_report_digest !== selection.license_report_digest) throw new Error('LICENSE_REPORT_DIGEST_MISMATCH');
  }
  const features = selection.selected_feature_ids.map(id => findFeature(catalog, id));
  const base = {
    schema_version: 1,
    selection_digest: selectionDigest(selection),
    catalog_hash: selection.catalog_hash,
    features: features.map(feature => ({
      feature_id: feature.feature_id,
      spec_digest: feature.spec_digest,
      kind: feature.kind ?? 'openapi-get',
      ...(feature.method ? { method: feature.method } : {}),
      ...(feature.path ? { path: feature.path } : {}),
      ...(feature.export_name ? { export_name: feature.export_name, module: feature.module } : {}),
    })),
    dependency_graph: Object.fromEntries(features.map(feature => [feature.feature_id, []])),
    scc_analysis: { algorithm: 'M1-selected-set-trivial', cycles: [] },
    order: [...selection.selected_feature_ids].sort(),
    template,
    permission_model: 'reviewed-template-only; not hostile-code containment',
    permission_ceiling: structuredClone(selection.permission_ceiling),
    budget: structuredClone(selection.budget),
    language: resolveLanguage(selection.language_choice, { transformationPlan }),
    ...(selection.license_report_digest != null
      ? { license_report_digest: selection.license_report_digest, transformation_plan_digest: transformationPlanDigest(transformationPlan) }
      : {}),
  };
  return deepFreeze({ ...base, plan_digest: objectDigest(base) });
}

export function planDigest(plan) {
  const { plan_digest: _ignored, ...base } = plan;
  return objectDigest(base);
}
