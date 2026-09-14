import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * M1.1 repo-tool child lifecycle: bounded DTO RPC to a worker that executes the
 * original source module. Same discipline as the M0 HTTP Supervisor (timeout,
 * cancellation, drain on close, digest handshake) but no network at all.
 * Not an untrusted-code sandbox: it is a process boundary with an fs-read
 * permission grant limited to the worker file and the source module.
 */
export class RepoSupervisor {
  constructor({ digest, timeoutMs = 1500, capability, workerFile = fileURLToPath(new URL('./repo-worker.mjs', import.meta.url)), modulePath }) {
    if (!capability?.name || typeof capability.module !== 'string' || typeof capability.export_name !== 'string') throw new Error('CAPABILITY_NOT_SUPPORTED');
    if (!modulePath) throw new Error('MODULE_PATH_REQUIRED');
    this.config = { digest, timeoutMs, capability, workerFile, modulePath };
    this.pending = new Map();
    this.state = 'new';
  }
  async start() {
    const { workerFile, modulePath, digest, timeoutMs, capability } = this.config;
    this.state = 'starting';
    const inputKeys = Object.keys(capability.input_schema?.properties ?? {});
    const child = this.child = spawn(process.execPath, [
      '--permission',
      `--allow-fs-read=${workerFile}`,
      `--allow-fs-read=${modulePath}`,
      '--max-old-space-size=64',
      workerFile,
    ], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        SystemRoot: process.env.SystemRoot,
        FORMA_ARTIFACT_DIGEST: digest,
        FORMA_CAPABILITY: JSON.stringify({ name: capability.name, module: capability.module, export_name: capability.export_name }),
        FORMA_MODULE_URL: pathToFileURL(modulePath).href,
        FORMA_INPUT_KEYS: JSON.stringify(inputKeys),
      },
    });
    this.exited = new Promise(resolve => child.once('close', resolve));
    let buffer = '';
    let stderrBytes = 0;
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 65536) this.fail('WORKER_PROTOCOL_ERROR'); });
    child.stdin.on('error', () => this.fail('WORKER_TERMINATED'));
    child.once('error', () => this.fail('WORKER_TERMINATED'));
    child.once('close', () => { this.exitObserved = true; if (this.state !== 'closed') this.fail('WORKER_TERMINATED'); });
    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve; this.rejectReady = reject;
      this.startTimer = setTimeout(() => this.fail('WORKER_TIMEOUT'), timeoutMs);
    });
    child.stdout.on('data', data => {
      buffer += data.toString('utf8');
      if (Buffer.byteLength(buffer) > 65536) { this.fail('WORKER_PROTOCOL_ERROR'); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.message(JSON.parse(line)); } catch (error) { this.fail(error.message?.startsWith('MODULE_LOAD_FAILED') ? error.message : 'WORKER_PROTOCOL_ERROR'); }
      }
    });
    await ready;
  }
  message(message) {
    if (message.type === 'load-error' && this.state === 'starting') {
      this.fail(`MODULE_LOAD_FAILED:${message.error}`);
      return;
    }
    if (message.type === 'ready' && this.state === 'starting') {
      if (message.protocol !== 1 || message.digest !== this.config.digest || message.capability !== this.config.capability.name || message.pid !== this.child.pid) throw new Error('HANDSHAKE_MISMATCH');
      this.state = 'ready'; clearTimeout(this.startTimer); this.resolveReady(); return;
    }
    if (message.type === 'stopped' && this.state === 'closing') return;
    const pending = this.pending.get(message.id);
    if (!pending) { if (this.state === 'closing' || this.state === 'degraded') return; throw new Error('UNKNOWN_RECEIPT'); }
    if (message.type !== 'result') throw new Error('INVALID_MESSAGE');
    this.pending.delete(message.id); clearTimeout(pending.timer); pending.detach();
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
  }
  validArgs(args) {
    const properties = this.config.capability.input_schema?.properties ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const keys = Object.keys(args);
    if (keys.length > 8) return false;
    for (const key of keys) {
      if (!(key in properties)) return false;
      if (typeof args[key] !== 'string' || args[key].length > 1024) return false;
    }
    return true;
  }
  send(message) { if (this.child?.stdin.writable && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(args, signal = new AbortController().signal) {
    if (this.state !== 'ready') return Promise.reject(new Error('WORKER_UNAVAILABLE'));
    if (this.pending.size >= 4) return Promise.reject(new Error('WORKER_BUSY'));
    if (signal.aborted) return Promise.reject(new Error('CANCELLED'));
    if (!this.validArgs(args)) return Promise.reject(new Error('INVALID_ARGUMENT'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const cancel = () => this.fail('CANCELLED');
      signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => this.fail('WORKER_TIMEOUT'), this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, controller, detach: () => signal.removeEventListener('abort', cancel) });
      this.send({ type: 'call', id, args });
    });
  }
  fail(code) {
    if (this.state === 'closed') return;
    this.state = 'degraded'; clearTimeout(this.startTimer); this.rejectReady?.(new Error(code));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.detach(); pending.controller.abort(); pending.reject(new Error(code));
    }
    this.pending.clear();
    this.child?.kill();
  }
  close() {
    return this.closing ??= (async () => {
      if (!this.child || this.state === 'closed') return;
      this.state = 'closing'; clearTimeout(this.startTimer);
      for (const pending of this.pending.values()) {
        pending.controller.abort(); pending.detach(); clearTimeout(pending.timer); pending.reject(new Error('CANCELLED'));
      }
      this.pending.clear();
      this.send({ type: 'shutdown' });
      const force = setTimeout(() => this.child.kill(), 500);
      await this.exited; clearTimeout(force);
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      this.state = 'closed';
    })();
  }
}
