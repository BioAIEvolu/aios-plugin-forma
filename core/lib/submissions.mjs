import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveJson } from './records.mjs';
import { validateSelection, selectionDigest, idempotencyResult } from './selection.mjs';
import { assertLicenseCleared } from './license.mjs';
import { assertTransformationCleared } from './transformation.mjs';

const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200; // ~5s max wait for a contended submission lock

/**
 * Local persistent submission index. This is the M1 submission coordination entry:
 * it decides whether a repeated submission returns an existing delivery, an
 * in-progress task, a new attempt, or must be reconciled/refused. It is not a
 * production storageDomain implementation; writes are atomic (temp + rename)
 * and serialized through a lock file so separate processes observe one truth.
 *
 * Each selection owns one record with an append-only `attempts` list. A retry
 * after ROLLED_BACK / reconciled FAILED pushes a new attempt and moves the
 * current pointer; previous attempts keep their full status history, delivery
 * reference and side-effect reconciliation result forever.
 */
export class SubmissionStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'submissions.json');
    this.lockPath = join(dir, 'submissions.lock');
    this.records = [];
  }
  async openStore() {
    await mkdir(this.dir, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value?.schema_version !== 2 || !Array.isArray(value.records)) throw new Error('SUBMISSIONS_CORRUPT');
      for (const record of value.records) {
        if (!Array.isArray(record.attempts) || record.attempts.length === 0 || typeof record.current_attempt_ref !== 'string') throw new Error('SUBMISSIONS_CORRUPT');
      }
      this.records = value.records;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  async #locked(fn) {
    let file;
    for (let attempt = 0; ; attempt++) {
      try { file = await open(this.lockPath, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt >= LOCK_ATTEMPTS) throw new Error('SUBMISSIONS_LOCKED');
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        // Re-read under contention: another process may have finished the submission.
        // Tolerate transient Windows replace-in-progress errors here; the
        // authoritative read happens after the lock is acquired.
        try { await this.openStore(); } catch { /* retry loop re-reads later */ }
      }
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      // Decisions must see the last committed state, not a stale in-memory copy.
      await this.openStore();
      const result = await fn();
      const temp = join(this.dir, `${randomUUID()}.tmp`);
      await saveJson(temp, { schema_version: 2, records: this.records });
      // Windows: rename over an existing destination can transiently fail while
      // another handle (reader, AV scan) has the file open. Retry briefly.
      for (let i = 0; ; i++) {
        try { await rename(temp, this.file); break; }
        catch (error) {
          if (!['EPERM', 'EBUSY', 'EEXIST'].includes(error.code) || i >= 20) throw error;
          await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        }
      }
      return result;
    } finally {
      await file.close();
      // Release by rename, not delete: the sandbox counts deletions per turn, and
      // archived lock files are harmless evidence inside disposable .work dirs.
      await rename(this.lockPath, join(this.dir, `released-${randomUUID()}.lock`));
    }
  }
  #find(digest) { return this.records.find(record => record.selection_digest === digest); }
  #current(record) {
    const attempt = record.attempts.find(item => item.attempt_ref === record.current_attempt_ref);
    if (!attempt) throw new Error('SUBMISSIONS_CORRUPT');
    return attempt;
  }

  /** Submit a frozen selection. Returns the coordination decision without executing side effects. */
  async submit(catalog, selection) {
    validateSelection(catalog, selection);
    return this.#locked(async () => {
      const record = this.#find(selectionDigest(selection));
      const decision = idempotencyResult(record ? { ...this.#current(record), selection_digest: record.selection_digest } : null, selection);
      if (decision.action === 'reconcile-required') throw Object.assign(new Error('SUBMISSION_STATE_UNCERTAIN'), { decision });
      const current = record ? this.#current(record) : null;
      if (decision.action === 'new-attempt' && current?.status === 'FAILED' && current.side_effects !== 'reconciled') {
        throw Object.assign(new Error('SUBMISSION_SIDE_EFFECTS_UNCERTAIN'), { attempt_ref: current.attempt_ref });
      }
      if (decision.action === 'new-attempt') {
        const attempt = {
          attempt_ref: decision.attempt_ref ?? `attempt-${randomUUID().slice(0, 8)}`,
          previous_attempt_ref: current?.attempt_ref ?? null,
          status: 'BUILDING',
          delivery_ref: null,
          side_effects: 'none',
          history: [{ status: 'BUILDING', at: new Date().toISOString() }],
        };
        if (record) {
          record.attempts.push(attempt);
          record.current_attempt_ref = attempt.attempt_ref;
        } else {
          this.records.push({ selection_digest: decision.selection_digest, current_attempt_ref: attempt.attempt_ref, attempts: [attempt] });
        }
        return { action: 'new-attempt', attempt_ref: attempt.attempt_ref, previous_attempt_ref: attempt.previous_attempt_ref, selection_digest: selectionDigest(selection) };
      }
      return decision;
    });
  }

  /**
   * Advance the current attempt of a submission along the allowed lifecycle.
   * Optional license gate: callers driving a license-bound selection pass
   * { licenseReport, transformationPlan, reviewRecord }; moving toward
   * VALIDATING/INSTALLING then requires assertLicenseCleared and
   * assertTransformationCleared to pass — review_required/blocked reports
   * without an independent review record can never reach install.
   */
  async transition(selection_digest, status, extra = {}, gate = {}) {
    const allowed = { BUILDING: ['VALIDATING', 'FAILED'], VALIDATING: ['INSTALLING', 'FAILED'], INSTALLING: ['ACTIVE', 'FAILED'], ACTIVE: ['ROLLED_BACK'], FAILED: [], ROLLED_BACK: [] };
    if (gate.licenseReport && (status === 'VALIDATING' || status === 'INSTALLING')) {
      assertLicenseCleared(gate.licenseReport, { reviewRecord: gate.reviewRecord });
      if (gate.transformationPlan) assertTransformationCleared(gate.transformationPlan, { reviewRecord: gate.reviewRecord });
    }
    return this.#locked(async () => {
      const record = this.#find(selection_digest);
      if (!record) throw new Error('SUBMISSION_NOT_FOUND');
      const attempt = this.#current(record);
      if (!allowed[attempt.status]?.includes(status)) throw new Error(`SUBMISSION_TRANSITION_DENIED:${attempt.status}->${status}`);
      Object.assign(attempt, extra, { status });
      attempt.history.push({ status, at: new Date().toISOString() });
      return structuredClone(attempt);
    });
  }

  /** Read-only view for reconciliation and cross-process verification. */
  inspect(selection_digest) {
    const record = this.#find(selection_digest);
    return record ? structuredClone(record) : null;
  }
}
