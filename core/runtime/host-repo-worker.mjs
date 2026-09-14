import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { RepoSupervisor } from './repo-supervisor.mjs';

export const inject = ['tools'];
export const Config = z.object({ runtimeDigest: z.string().required(), timeoutMs: z.number().min(100).max(10000).required() });

function expectedOutputLicense(report, plan, reviewRecord) {
  const sourceSpdx = report.detected?.find(item => item.scope === 'source' && item.spdx)?.spdx;
  switch (plan.output_license_strategy) {
    case 'inherit':
    case 'compatible-new-code': return sourceSpdx ?? 'SEE LICENSE';
    case 'separate-component': return 'SEE LICENSE';
    case 'review-required': return reviewRecord?.approved_output_license ?? 'SEE LICENSE';
    default: throw new Error('OUTPUT_LICENSE_STRATEGY_UNKNOWN');
  }
}

/**
 * M1.1 repo-tool host template (safe execution route). The Host never imports
 * or evaluates the original source: it only verifies the frozen digest set and
 * registers one tool whose execute delegates a versioned DTO to the
 * Supervisor-managed worker. The original module runs only in that worker.
 */
export async function apply(ctx, config) {
  const encoded = JSON.parse(await readFile(new URL('./capability.json', import.meta.url)));
  const capabilities = Array.isArray(encoded) ? encoded : [encoded];
  if (capabilities.length === 0 || capabilities.some(capability => !capability.name || capability.kind !== 'repo-function' || typeof capability.module !== 'string' || typeof capability.export_name !== 'string')) throw new Error('CAPABILITY_NOT_SUPPORTED');
  const names = [...new Set(['capability.json', 'host.mjs', 'repo-supervisor.mjs', 'repo-worker.mjs', 'package.json', 'specs/license-report.json', 'specs/transformation-plan.json', 'specs/license-review-record.json', 'specs/license-output.json', ...capabilities.map(capability => capability.module)])];
  const hashes = [];
  for (const name of names) {
    hashes.push([name, createHash('sha256').update(await readFile(new URL('./' + name, import.meta.url))).digest('hex')]);
  }
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  if (digest !== config.runtimeDigest) throw new Error('RUNTIME_DIGEST_MISMATCH');
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
  const report = JSON.parse(await readFile(new URL('./specs/license-report.json', import.meta.url)));
  const plan = JSON.parse(await readFile(new URL('./specs/transformation-plan.json', import.meta.url)));
  const reviewRecord = JSON.parse(await readFile(new URL('./specs/license-review-record.json', import.meta.url)));
  const licenseOutput = JSON.parse(await readFile(new URL('./specs/license-output.json', import.meta.url)));
  const expectedLicense = expectedOutputLicense(report, plan, reviewRecord);
  if (packageJson.license !== expectedLicense || licenseOutput.package_license !== expectedLicense || licenseOutput.output_license_strategy !== plan.output_license_strategy) throw new Error('OUTPUT_LICENSE_MISMATCH');
  const supervisors = capabilities.map(capability => new RepoSupervisor({ digest, timeoutMs: config.timeoutMs, capability, modulePath: fileURLToPath(new URL('./' + capability.module, import.meta.url)) }));
  await ctx.effect(async () => {
    try {
      for (const supervisor of supervisors) await supervisor.start();
      const unregister = capabilities.map((capability, index) => ctx.tools.register({
        name: capability.name,
        description: capability.description,
        parameters: capability.input_schema,
        output: { schema: capability.output_schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (args, exec) => supervisors[index].call(args, exec.signal),
      }));
      ctx.provide('formaCandidate', { supervisors, supervisor: supervisors[0], fiber: ctx.fiber, cordis: Context, kind: 'repo-worker', capability: capabilities.length === 1 ? capabilities[0].name : capabilities.map(item => item.name) });
      return async () => { for (const dispose of unregister) dispose(); const results = []; for (const supervisor of [...supervisors].reverse()) results.push(await supervisor.close()); process.stdout.write('FORMA_CLEANUP ' + JSON.stringify({ workers: results, capabilities: capabilities.map(item => item.name) }) + '\n'); };
    } catch (error) { for (const supervisor of supervisors) await supervisor.close(); throw error; }
  });
}
