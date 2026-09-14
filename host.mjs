import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { FormaSupervisor } from './supervisor.mjs';

export const inject = ['tools'];
export const Config = z.object({
  runtimeDigest: z.string().required(),
  workRoot: z.string().required(),
  sourceRootsJson: z.string().required(),
  reviewedSourceRootsJson: z.string(),
  timeoutMs: z.number().min(250).max(120000).required(),
});

const TOOL_SCHEMAS = {
  forma_source_snapshot: {
    type: 'object', required: ['source_dir'], additionalProperties: false,
    properties: { source_dir: { type: 'string', minLength: 1, maxLength: 1024 }, canonical_uri: { type: 'string', maxLength: 2048 }, run_id: { type: 'string', maxLength: 128 } },
  },
  forma_scan_capabilities: {
    type: 'object', additionalProperties: false,
    properties: { source_dir: { type: 'string', maxLength: 1024 }, run_id: { type: 'string', maxLength: 128 }, openapi_file: { type: 'string', maxLength: 256 } },
  },
  forma_create_selection: {
    type: 'object', required: ['run_id', 'feature_ids'], additionalProperties: false,
    properties: { run_id: { type: 'string', minLength: 1, maxLength: 128 }, feature_ids: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 128 } }, target: { type: 'string' }, actor: { type: 'string' }, submission_ref: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, permission_ceiling: { type: 'object' }, budget: { type: 'object' }, language_choice: { type: 'object' }, license_report_digest: { type: 'string' }, transformation_mode: { type: 'string' } },
  },
  forma_plan_transformation: {
    type: 'object', required: ['run_id'], additionalProperties: false,
    properties: { run_id: { type: 'string', minLength: 1, maxLength: 128 }, mode: { type: 'string' }, language_choice: { type: 'object' }, source_language: { type: 'string' }, notices: { type: 'array' }, isolation: { type: 'object' }, external_component: { type: 'object' } },
  },
  forma_build_candidate: {
    type: 'object', required: ['run_id'], additionalProperties: false,
    properties: { run_id: { type: 'string', minLength: 1, maxLength: 128 }, candidate_dir: { type: 'string', maxLength: 1024 }, package_name: { type: 'string', maxLength: 96 }, package_version: { type: 'string', maxLength: 64 }, template: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 250, maximum: 120000 } },
  },
  forma_validate_candidate: {
    type: 'object', required: ['run_id'], additionalProperties: false,
    properties: { run_id: { type: 'string', minLength: 1, maxLength: 128 } },
  },
  forma_export_plugin_repo: {
    type: 'object', required: ['run_id'], additionalProperties: false,
    properties: { run_id: { type: 'string', minLength: 1, maxLength: 128 }, export_dir: { type: 'string', maxLength: 1024 } },
  },
};

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function verifyRuntime(expectedDigest) {
  const manifestBytes = await readFile(new URL('./integrity-manifest.json', import.meta.url));
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { throw new Error('INTEGRITY_MANIFEST_INVALID'); }
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 6) throw new Error('INTEGRITY_MANIFEST_INVALID');
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || entry.path.includes('..') || typeof entry.sha256 !== 'string') throw new Error('INTEGRITY_MANIFEST_INVALID');
    const bytes = await readFile(new URL('./' + entry.path.replaceAll('\\', '/'), import.meta.url));
    if (hash(bytes) !== entry.sha256) throw new Error(`INTEGRITY_MISMATCH:${entry.path}`);
  }
  const actual = 'sha256:' + hash(JSON.stringify({ schema_version: manifest.schema_version, files: manifest.files, manifest_sha256: hash(manifestBytes) }));
  if (actual !== expectedDigest) throw new Error('RUNTIME_DIGEST_MISMATCH');
  return { digest: actual, files: manifest.files.map(entry => entry.path) };
}

function render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; }

export async function apply(ctx, config) {
  const identity = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
  if (identity.name !== 'aios-plugin-forma') throw new Error('PLUGIN_IDENTITY_MISMATCH');
  const integrity = await verifyRuntime(config.runtimeDigest);
  let sourceRoots;
  try { sourceRoots = JSON.parse(config.sourceRootsJson); } catch { throw new Error('SOURCE_ROOTS_INVALID'); }
  if (!Array.isArray(sourceRoots) || sourceRoots.some(root => typeof root !== 'string')) throw new Error('SOURCE_ROOTS_INVALID');
  let reviewedSourceRoots = [];
  try { reviewedSourceRoots = config.reviewedSourceRootsJson ? JSON.parse(config.reviewedSourceRootsJson) : []; } catch { throw new Error('REVIEWED_SOURCE_ROOTS_INVALID'); }
  if (!Array.isArray(reviewedSourceRoots) || reviewedSourceRoots.some(root => typeof root !== 'string')) throw new Error('REVIEWED_SOURCE_ROOTS_INVALID');
  // Core is versioned inside this package. Only source roots and managed work
  // are caller-configurable; no Profile may redirect execution to a workspace.
  const coreRoot = fileURLToPath(new URL('./core', import.meta.url));
  const supervisor = new FormaSupervisor({ workerFile: fileURLToPath(new URL('./worker.mjs', import.meta.url)), coreRoot, workRoot: resolve(config.workRoot), sourceRoots: sourceRoots.map(root => resolve(root)), reviewedSourceRoots: reviewedSourceRoots.map(root => resolve(root)), timeoutMs: config.timeoutMs });
  await ctx.effect(async () => {
    try {
      await supervisor.start();
      const unregister = Object.entries(TOOL_SCHEMAS).map(([name, parameters]) => ctx.tools.register({
        name, description: `Forma ${name.slice('forma_'.length).replaceAll('_', ' ')} (DTO v1)`, parameters,
        output: { schema: { type: 'object' }, render },
        execute: (args, exec) => supervisor.call(name, args ?? {}, exec.signal),
      }));
      ctx.provide('formaBuilder', { state: supervisor.state, protocol: 1, tools: Object.keys(TOOL_SCHEMAS), runtimeDigest: integrity.digest, supervisor, workerPid: supervisor.child.pid });
      return async () => {
        const result = await supervisor.close();
        for (const dispose of unregister) dispose();
        process.stdout.write('FORMA_PLUGIN_CLEANUP ' + JSON.stringify({ ...result, workerPid: supervisor.child?.pid, tools: Object.keys(TOOL_SCHEMAS) }) + '\n');
      };
    } catch (error) {
      await supervisor.close();
      throw error;
    }
  });
}
