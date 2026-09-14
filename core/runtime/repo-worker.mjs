import { createInterface } from 'node:readline';

// M1.1 repo-tool worker template. The ORIGINAL source module is loaded and
// executed only inside this Supervisor-managed child process (spawned with
// --permission and explicit --allow-fs-read grants), never in the DSH Host.
// Receives only versioned DTOs over stdio; bounded args, bounded results.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const capability = JSON.parse(process.env.FORMA_CAPABILITY || '{}');
const moduleUrl = process.env.FORMA_MODULE_URL;
const inputKeys = Object.freeze(JSON.parse(process.env.FORMA_INPUT_KEYS || '[]'));

function validArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  if (keys.length > 8) return false;
  for (const key of keys) {
    if (!inputKeys.includes(key)) return false;
    const value = args[key];
    if (typeof value !== 'string' || value.length > 1024) return false;
  }
  return true;
}

let fn = null;
try {
  const module = await import(moduleUrl);
  fn = module[capability.export_name];
  if (typeof fn !== 'function') throw new Error('CAPABILITY_EXPORT_MISSING');
} catch (error) {
  send({ type: 'load-error', error: error.message });
  process.exit(1);
}
send({ type: 'ready', protocol: 1, digest: process.env.FORMA_ARTIFACT_DIGEST, capability: capability.name, pid: process.pid });

lines.on('line', line => {
  if (Buffer.byteLength(line) > 65536) { process.exitCode = 2; lines.close(); return; }
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 2; lines.close(); return; }
  if (message.type === 'shutdown') { send({ type: 'stopped' }); lines.close(); return; }
  if (message.type === 'call') {
    if (typeof message.id !== 'string' || !validArgs(message.args)) {
      send({ type: 'result', id: message.id, error: 'INVALID_ARGUMENT' }); return;
    }
    Promise.resolve()
      .then(() => fn(message.args ?? {}))
      .then(value => {
        const text = JSON.stringify(value ?? null);
        if (Buffer.byteLength(text) > 65536) send({ type: 'result', id: message.id, error: 'RESULT_TOO_LARGE' });
        else send({ type: 'result', id: message.id, value });
      }, error => send({ type: 'result', id: message.id, error: String(error?.message ?? error).slice(0, 512) }));
  }
});
