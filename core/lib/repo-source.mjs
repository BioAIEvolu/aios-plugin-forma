import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, objectDigest, deepFreeze } from './records.mjs';

/**
 * Narrow M1.1 RepoSourceAdapter: fixed LOCAL independent code repositories only.
 * No GitHub download, no registry lookup, no git operations.
 *
 * Scan-stage safety boundary: the adapter only READS bytes. It never runs
 * install/prepare/postinstall scripts and never imports or evaluates source
 * files. Capability facts come from three static evidence classes:
 *   1. exported symbols discovered by regex over source bytes,
 *   2. machine-readable JSDoc `@capability` blocks attached to those exports,
 *   3. README capability mentions and test-file names.
 * A file name or export name alone is never treated as proof of behavior;
 * features without a @capability JSDoc block are listed as `unverified_exports`,
 * not as capabilities.
 */

const CAPABILITY_BLOCK = /\/\*\*([\s\S]*?)\*\/\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\((\{[^)]*\})?/g;
const EXPORT_SYMBOL = /^\s*export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
const TAG = /@(capability|description|input|output|throws)\b([^\n@]*)/g;

/** Recursively list repository files, excluding dependency/build directories. */
async function listFiles(root, prefix = '') {
  const out = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const entry = join(root, path);
    try {
      const stat = await readdir(entry);
      if (Array.isArray(stat)) { out.push(...await listFiles(root, path)); continue; }
    } catch { /* not a directory */ }
    out.push(path);
  }
  return out;
}

async function readIfExists(root, path) {
  try { return await readFile(join(root, path), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') return null; throw error; }
}

/**
 * Mechanical trust classification for the direct-source route.
 * Only project-owned fixtures under <workspace>/fixtures are
 * 'trusted-local-fixture'; everything else is 'untrusted-external' and the
 * direct-source candidate route must refuse it. This is a gate, not a claim
 * that fixtures are "safe" — it records why execution is tolerated at all.
 */
const fixturesRoot = resolve(fileURLToPath(new URL('../../fixtures', import.meta.url)));
export function classifySourceTrust(repoDir, trustedRoots = []) {
  const resolved = resolve(repoDir);
  if (Array.isArray(trustedRoots) && trustedRoots.some(root => {
    const base = resolve(root);
    return resolved === base || resolved.startsWith(base + sep);
  })) return 'trusted-configured-source-root';
  return resolved.startsWith(fixturesRoot + sep) ? 'trusted-local-fixture' : 'untrusted-external';
}

/** Create a complete SourceSnapshot: file manifest, version, source URI and license evidence refs. */
export async function createRepoSnapshot(repoDir, { canonicalUri, trustedRoots = [] } = {}) {
  const fileManifest = await manifest(repoDir);
  const pkg = JSON.parse(await readIfExists(repoDir, 'package.json') ?? '{}');
  const licenseEvidence = fileManifest
    .filter(entry => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.[^/]*)?$/i.test(entry.path) || entry.path === 'package.json' || entry.path === 'package-lock.json')
    .map(entry => ({ path: entry.path, sha256: entry.sha256 }));
  return {
    schema_version: 1,
    kind: 'local-repo',
    source_id: objectDigest(fileManifest),
    canonical_uri: canonicalUri ?? repoDir,
    trust: classifySourceTrust(repoDir, trustedRoots),
    version: typeof pkg.version === 'string' ? pkg.version : null,
    package_name: typeof pkg.name === 'string' ? pkg.name : null,
    file_manifest: fileManifest,
    license_evidence: licenseEvidence,
    rights: { license: 'DEFERRED', basis: 'determined by forma/lib/license.mjs scan; never by package name or user claim' },
  };
}

function parseCapabilityBlock(block, name) {
  const tags = {};
  for (const match of block.matchAll(TAG)) tags[match[1]] = (tags[match[1]] ?? []).concat(match[2].trim());
  if (!tags.capability) return null;
  const inputs = {};
  for (const line of tags.input ?? []) {
    const parsed = line.match(/^([A-Za-z_$][\w$]*)\s*:\s*(\w+)/);
    if (parsed) inputs[parsed[1]] = { type: parsed[2] === 'number' ? 'number' : parsed[2] === 'boolean' ? 'boolean' : 'string' };
  }
  const output = (tags.output?.[0] ?? 'object').trim();
  return {
    name,
    description: (tags.description?.[0] ?? name).trim(),
    input: { type: 'object', properties: inputs, required: Object.keys(inputs), additionalProperties: false },
    output: output === 'string' ? { type: 'string' } : output === 'number' ? { type: 'number' } : output === 'boolean' ? { type: 'boolean' } : { type: 'object' },
    errors: (tags.throws ?? []).map(line => { const code = line.match(/^([A-Z_]+)/); return { status: code ? code[1] : 'ERROR', description: line }; }),
  };
}

/** Statically scan a local repo into an evidence-bearing FeatureCatalog. No code is executed. */
export async function buildRepoFeatureCatalog(repoDir, { sourceDigest } = {}) {
  const files = await listFiles(repoDir);
  const sourceFiles = files.filter(path => /\.mjs$/.test(path) && !path.startsWith('test/'));
  const testFiles = files.filter(path => /^test\/.*\.test\.mjs$/.test(path));
  const features = [];
  const unverified = [];
  for (const path of sourceFiles) {
    const text = await readFile(join(repoDir, path), 'utf8');
    const exported = [...text.matchAll(EXPORT_SYMBOL)].map(match => match[1]);
    const capabilities = new Map();
    for (const match of text.matchAll(CAPABILITY_BLOCK)) {
      const parsed = parseCapabilityBlock(match[1], match[2]);
      if (parsed) capabilities.set(match[2], { parsed, line: text.slice(0, match.index).split('\n').length });
    }
    for (const name of exported) {
      const found = capabilities.get(name);
      if (!found) { unverified.push({ export: name, file: path, reason: 'no @capability JSDoc evidence; name alone is not behavior proof' }); continue; }
      const feature = {
        feature_id: found.parsed.name,
        kind: 'repo-function',
        export_name: name,
        module: path,
        description: found.parsed.description,
        input: found.parsed.input,
        output: found.parsed.output,
        errors: found.parsed.errors,
        evidence: [{ kind: 'static-jsdoc', ref: `${path}#L${found.line}`, strength: 'declared' }],
        permissions: { network: [], paths: [], credentials: [] },
      };
      features.push(feature);
    }
  }
  // README and test names are corroborating evidence, never standalone proof.
  const readme = await readIfExists(repoDir, 'README.md');
  for (const feature of features) {
    if (readme?.includes(feature.feature_id)) feature.evidence.push({ kind: 'readme', ref: 'README.md', strength: 'corroborating' });
    if (testFiles.length > 0) feature.evidence.push({ kind: 'test-name', ref: testFiles[0], strength: 'corroborating' });
    feature.spec_digest = objectDigest(feature);
  }
  const base = {
    schema_version: 1,
    kind: 'repo-catalog',
    source_digest: sourceDigest ?? null,
    scan_boundary: 'static scan only: reads bytes, runs no install/prepare/postinstall scripts, imports/evaluates no source code; JSDoc declarations and test names are declared evidence, not executed behavior proof',
    features: features.sort((a, b) => a.feature_id.localeCompare(b.feature_id)),
    unverified_exports: unverified,
  };
  return deepFreeze({ ...base, catalog_hash: objectDigest(base) });
}

export { listFiles as listRepoFiles, readIfExists };
