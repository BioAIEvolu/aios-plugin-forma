import { findFeature } from './catalog.mjs';

/**
 * B01 canonical permission representation.
 * permission_ceiling / required permissions share one shape:
 *   { network: Array<`${origin}${path-template}`>, paths: string[], credentials: string[] }
 * A network entry authorizes exactly one GET on one concrete loopback origin + OpenAPI path
 * template (e.g. "http://127.0.0.1:54321/items/{id}"). Matching is exact string membership;
 * an empty network array grants nothing, not even loopback.
 */
export function assertValidCeiling(ceiling) {
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) throw new Error('PERMISSION_CEILING_INVALID');
  for (const key of ['network', 'paths', 'credentials']) {
    if (!Array.isArray(ceiling[key]) || ceiling[key].some(value => typeof value !== 'string' || value.length === 0)) throw new Error(`PERMISSION_CEILING_INVALID:${key}`);
  }
  return true;
}

/** Permissions a frozen selection actually needs. OpenAPI GET features need one
 *  concrete loopback origin + path each; local repo-function features are pure
 *  and need no network at all. An origin is only required when network entries exist. */
export function requiredPermissions(catalog, selection, origin) {
  const paths = selection.selected_feature_ids.map(id => findFeature(catalog, id).path).filter(path => typeof path === 'string');
  if (paths.length > 0 && (typeof origin !== 'string' || !origin.startsWith('http://127.0.0.1:'))) throw new Error('PERMISSION_ORIGIN_UNSUPPORTED');
  return {
    network: paths.map(path => origin + path),
    paths: [],
    credentials: [],
  };
}

/** Fail before generation/boot/request when the required permissions exceed the frozen ceiling. */
export function assertPermissionSubset(ceiling, required) {
  assertValidCeiling(ceiling);
  for (const key of ['network', 'paths', 'credentials']) {
    for (const entry of required[key]) {
      if (!ceiling[key].includes(entry)) throw new Error(`PERMISSION_DENIED:${key}:${entry}`);
    }
  }
  return true;
}
