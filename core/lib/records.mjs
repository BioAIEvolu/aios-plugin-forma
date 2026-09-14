import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const objectDigest = value => digest(canonical(value));
/** Recursively freeze nested objects/arrays so frozen specs cannot be mutated through shared references. */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
export async function saveJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
export async function manifest(root, prefix = '') {
  const entries = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REJECTED');
    if (stat.isDirectory()) entries.push(...await manifest(root, path));
    else if (stat.isFile()) { const bytes = await readFile(join(root, path)); entries.push({ path, size: bytes.length, sha256: digest(bytes) }); }
    else throw new Error('SOURCE_FILE_TYPE_REJECTED');
  }
  return entries;
}
export async function verifyManifest(root, expected) {
  if (objectDigest(await manifest(root)) !== objectDigest(expected)) throw new Error('SOURCE_SNAPSHOT_CHANGED');
}

/** Local M0 evidence journal. This is not a production storageDomain implementation. */
export class Journal {
  constructor(root) { this.root = root; this.events = []; }
  async open() {
    await mkdir(this.root, { recursive: true });
    try { this.events = JSON.parse(await readFile(join(this.root, 'journal.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.events)) throw new Error('JOURNAL_CORRUPT');
    let previous = null;
    for (let i = 0; i < this.events.length; i++) {
      const { digest, ...value } = this.events[i];
      if (value.sequence !== i + 1 || value.previous !== previous || objectDigest(value) !== digest) throw new Error('JOURNAL_CORRUPT');
      previous = digest;
    }
    return this;
  }
  async append(state, refs = {}) {
    const previous = this.events.at(-1)?.digest ?? null;
    const record = { sequence: this.events.length + 1, state, refs, previous, timestamp: new Date().toISOString() };
    record.digest = objectDigest(record);
    this.events.push(record);
    const temp = join(this.root, `${randomUUID()}.tmp`);
    await saveJson(temp, this.events);
    await rename(temp, join(this.root, 'journal.json'));
    return record;
  }
}
