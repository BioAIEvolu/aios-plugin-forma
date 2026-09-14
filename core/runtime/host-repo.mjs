import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

export const inject = ['tools'];
export const Config = z.object({ runtimeDigest: z.string().required() });

/**
 * M1.1 EXPERIMENTAL fixture-only template (superseded). This host imports the
 * original module into the DSH Host process, which is only acceptable for the
 * project-owned trusted fixtures it was prototyped with. Candidate generation
 * (generateRepoCandidate) no longer uses it; the safe route is
 * host-repo-worker.mjs, where the Host never imports source and the module runs
 * in a Supervisor-managed worker. Kept for archaeology; do not wire it back.
 */
export async function apply(ctx, config) {
  const capability = JSON.parse(await readFile(new URL('./capability.json', import.meta.url)));
  if (!capability.name || capability.kind !== 'repo-function' || typeof capability.module !== 'string' || typeof capability.export_name !== 'string') throw new Error('CAPABILITY_NOT_SUPPORTED');
  const hashes = [];
  for (const name of ['capability.json', 'host.mjs', capability.module]) {
    hashes.push([name, createHash('sha256').update(await readFile(new URL('./' + name, import.meta.url))).digest('hex')]);
  }
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  if (digest !== config.runtimeDigest) throw new Error('RUNTIME_DIGEST_MISMATCH');
  const module = await import(new URL('./' + capability.module, import.meta.url));
  const fn = module[capability.export_name];
  if (typeof fn !== 'function') throw new Error('CAPABILITY_EXPORT_MISSING');
  await ctx.effect(async () => {
    const unregister = ctx.tools.register({
      name: capability.name,
      description: capability.description,
      parameters: capability.input_schema,
      output: { schema: capability.output_schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: args => {
        for (const key of Object.keys(args ?? {})) {
          if (!capability.input_schema.properties || !(key in capability.input_schema.properties)) throw new Error('INVALID_ARGUMENT');
        }
        return fn(args ?? {});
      },
    });
    ctx.provide('formaCandidate', { state: 'ready', cordisModule: true, capability: capability.name });
    return async () => { unregister(); process.stdout.write('FORMA_CLEANUP ' + JSON.stringify({ capability: capability.name }) + '\n'); };
  });
}
