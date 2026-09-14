import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifest, objectDigest, deepFreeze } from './records.mjs';

const encodePointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** Create a stable source snapshot for a local OpenAPI fixture/project. */
export async function createSourceSnapshot(sourceDir, { canonicalUri = sourceDir, rights = { license: 'UNKNOWN' } } = {}) {
  const fileManifest = await manifest(sourceDir);
  return { schema_version: 1, source_id: objectDigest(fileManifest), canonical_uri: canonicalUri, file_manifest: fileManifest, rights };
}

export async function readOpenApi(sourceDir, file = 'openapi.json') {
  return JSON.parse(await readFile(join(sourceDir, file), 'utf8'));
}

function schemaForInput(operation) {
  const properties = {};
  const required = [];
  for (const parameter of operation.parameters ?? []) {
    if (parameter.in !== 'path' && parameter.in !== 'query') continue;
    properties[parameter.name] = parameter.schema ?? {};
    if (parameter.required) required.push(parameter.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function responseSchema(operation) {
  const response = operation.responses?.['200'] ?? operation.responses?.['201'] ?? Object.values(operation.responses ?? {})[0];
  return response?.content?.['application/json']?.schema ?? { type: 'object' };
}

/** Parse GET operations into a reusable, evidence-bearing FeatureCatalog. */
export function buildFeatureCatalog(api, { sourceDigest, openapiFile = 'openapi.json' } = {}) {
  if (!api || !api.paths || typeof api.paths !== 'object') throw new Error('OPENAPI_PATHS_REQUIRED');
  const features = [];
  for (const path of Object.keys(api.paths).sort()) {
    const operation = api.paths[path]?.get;
    if (!operation) continue;
    if (!operation.operationId) throw new Error(`OPENAPI_OPERATION_ID_REQUIRED:${path}`);
    const errors = Object.entries(operation.responses ?? {})
      .filter(([status]) => !/^2\d\d$/.test(status))
      .map(([status, response]) => ({ status, description: response.description ?? '', schema: response.content?.['application/json']?.schema ?? null }));
    const feature = {
      feature_id: operation.operationId,
      method: 'GET',
      path,
      description: operation.summary ?? operation.description ?? operation.operationId,
      input: schemaForInput(operation),
      output: responseSchema(operation),
      errors,
      evidence: [{ kind: 'openapi', ref: `${openapiFile}#/paths/${encodePointer(path)}/get`, strength: 'source' }],
      permissions: { network: [path], paths: [], credentials: [] },
    };
    feature.spec_digest = objectDigest(feature);
    features.push(feature);
  }
  const base = { schema_version: 1, source_digest: sourceDigest ?? null, features };
  return deepFreeze({ ...base, catalog_hash: objectDigest(base) });
}

export function catalogHash(catalog) {
  const { catalog_hash: _ignored, ...base } = catalog;
  return objectDigest(base);
}

export function findFeature(catalog, featureId) {
  return catalog.features.find(feature => feature.feature_id === featureId);
}
