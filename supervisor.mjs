import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_IN_FLIGHT = 4;
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Small, versioned stdio gateway. It owns the Worker process and never exposes
 * a source-module import/eval API to the DSH Host. The worker is disposable:
 * a protocol error, timeout or cancellation degrades and terminates it.
 */
export class FormaSupervisor {
  constructor({ workerFile, coreRoot, workRoot, sourceRoots, reviewedSourceRoots = [], timeoutMs = 15000, maxResultBytes = 4 * 1024 * 1024 }) {
    if (!workerFile || !coreRoot || !workRoot) throw new Error('FORMA_WORKER_CONFIG_REQUIRED');
    this.config = { workerFile, coreRoot, workRoot, sourceRoots: sourceRoots ?? [], reviewedSourceRoots: reviewedSourceRoots ?? [], timeoutMs, maxResultBytes };
    this.pending = new Map();
    this.state = 'new';
  }

  async start() {
    if (this.state !== 'new') throw new Error('WORKER_ALREADY_STARTED');
    const { workerFile, coreRoot, workRoot, sourceRoots, reviewedSourceRoots } = this.config;
    const args = [];
    // Opt-in because Node's permission flag is still experimental on some of
    // the supported Windows builds. The path checks in worker.mjs always apply.
    if (process.env.FORMA_NODE_PERMISSION === '1') {
      args.push('--permission', '--allow-child-process', `--allow-fs-read=${workerFile}`, `--allow-fs-read=${coreRoot}`, ...sourceRoots.map(root => `--allow-fs-read=${root}`), `--allow-fs-write=${workRoot}`);
    }
    args.push(workerFile);
    this.state = 'starting';
    const child = this.child = spawn(process.execPath, args, {
      cwd: workRoot,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        Path: process.env.Path,
        PATHEXT: process.env.PATHEXT,
        ComSpec: process.env.ComSpec,
        SystemRoot: process.env.SystemRoot,
        FORMA_NPM_EXEC_PATH: process.env.FORMA_NPM_EXEC_PATH || process.env.npm_execpath || '',
        FORMA_INTERNAL_CORE_ROOT: coreRoot,
        FORMA_WORK_ROOT: workRoot,
        FORMA_SOURCE_ROOTS: JSON.stringify(sourceRoots),
        FORMA_REVIEWED_SOURCE_ROOTS: JSON.stringify(reviewedSourceRoots),
      },
    });
    this.exited = new Promise(resolve => child.once('close', resolve));
    let buffer = '';
    let stderrBytes = 0;
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) this.fail('WORKER_STDERR_LIMIT');
    });
    child.once('error', () => this.fail('WORKER_TERMINATED'));
    child.once('close', () => { this.exitObserved = true; if (this.state !== 'closing' && this.state !== 'closed') this.fail('WORKER_TERMINATED'); });
    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.startTimer = setTimeout(() => this.fail('WORKER_TIMEOUT'), this.config.timeoutMs);
    });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) return this.fail('WORKER_PROTOCOL_LIMIT');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.fail('WORKER_PROTOCOL_LIMIT');
        try { this.message(JSON.parse(line)); } catch (error) { this.fail(error.message === 'WORKER_HANDSHAKE_MISMATCH' ? error.message : 'WORKER_PROTOCOL_ERROR'); }
      }
    });
    await ready;
  }

  message(message) {
    if (message?.type === 'ready' && this.state === 'starting') {
      if (message.protocol !== 1 || message.pid !== this.child.pid || message.worker !== 'forma-core') throw new Error('WORKER_HANDSHAKE_MISMATCH');
      this.state = 'ready';
      clearTimeout(this.startTimer);
      this.resolveReady();
      return;
    }
    if (message?.type === 'stopped' && this.state === 'closing') return;
    const item = this.pending.get(message?.id);
    if (!item) {
      if (this.state === 'closing' || this.state === 'degraded') return;
      throw new Error('WORKER_UNKNOWN_RECEIPT');
    }
    if (message.type !== 'result') throw new Error('WORKER_INVALID_RECEIPT');
    this.pending.delete(message.id);
    clearTimeout(item.timer);
    item.detach();
    if (message.error) item.reject(new Error(String(message.error).slice(0, 512)));
    else {
      const encoded = JSON.stringify(message.value ?? null);
      if (Buffer.byteLength(encoded) > this.config.maxResultBytes) item.reject(new Error('RESULT_TOO_LARGE'));
      else item.resolve(message.value);
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable || this.child.stdin.destroyed) throw new Error('WORKER_UNAVAILABLE');
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('REQUEST_TOO_LARGE');
    this.child.stdin.write(line);
  }

  call(tool, arguments_, signal = new AbortController().signal) {
    if (this.state !== 'ready') return Promise.reject(new Error('WORKER_UNAVAILABLE'));
    if (this.pending.size >= MAX_IN_FLIGHT) return Promise.reject(new Error('WORKER_BUSY'));
    if (typeof tool !== 'string' || !/^forma_[a-z_]+$/.test(tool)) return Promise.reject(new Error('TOOL_NOT_ALLOWED'));
    if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return Promise.reject(new Error('INVALID_ARGUMENT'));
    if (Buffer.byteLength(JSON.stringify(arguments_)) > 512 * 1024) return Promise.reject(new Error('REQUEST_TOO_LARGE'));
    if (signal.aborted) return Promise.reject(new Error('CANCELLED'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => this.fail('CANCELLED');
      const timer = setTimeout(() => this.fail('WORKER_TIMEOUT'), this.config.timeoutMs);
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, { resolve, reject, timer, detach: () => signal.removeEventListener('abort', cancel) });
      try { this.send({ protocol: 1, type: 'call', id, tool, arguments: arguments_ }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); signal.removeEventListener('abort', cancel); reject(error); }
    });
  }

  fail(code) {
    if (this.state === 'closed') return;
    this.state = 'degraded';
    clearTimeout(this.startTimer);
    this.rejectReady?.(new Error(code));
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.detach(); item.reject(new Error(code)); }
    this.pending.clear();
    this.child?.kill();
  }

  async close() {
    if (!this.child || this.state === 'closed') return { state: 'closed', exited: this.exitObserved === true };
    this.state = 'closing';
    clearTimeout(this.startTimer);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.detach(); item.reject(new Error('CANCELLED')); }
    this.pending.clear();
    try { this.send({ protocol: 1, type: 'shutdown' }); } catch { /* already gone */ }
    const force = setTimeout(() => this.child.kill(), 750);
    await this.exited;
    clearTimeout(force);
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    this.state = 'closed';
    return { state: this.state, exited: this.exitObserved === true };
  }
}
