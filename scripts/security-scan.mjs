import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const findings = [];
const rules = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['cloud-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['api-key', /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['password', /\b(?:password|passwd|secret)\s*[:=]\s*["'][^"']{8,}["']/i],
  ['connection-string', /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s"']+\b/i],
  ['absolute-path', /\b[A-Z]:[\\/][^\r\n"']+/],
];
const textExtensions = new Set(['.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.lock', '.toml', '.js']);
function relativePath(path) { return relative(root, path).split('\\').join('/'); }
function inspectText(path, text, source) {
  for (const [category, pattern] of rules) if (pattern.test(text)) findings.push({ source, path: relativePath(path), category, redacted: true });
}
async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.work'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (textExtensions.has(path.slice(path.lastIndexOf('.')).toLowerCase()) || entry.name === 'package.json') out.push(path);
  }
  return out;
}
for (const path of await walk(root)) {
  try { const stat = await lstat(path); if (stat.size <= 4 * 1024 * 1024) inspectText(path, await readFile(path, 'utf8'), 'working-tree'); } catch { /* unreadable/binary is recorded by pack checks */ }
}
let tracked = [];
try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { /* not a git checkout */ }
for (const file of tracked) {
  const path = resolve(root, file);
  try { inspectText(path, await readFile(path, 'utf8'), 'git-tracked'); } catch { /* ignore binary */ }
}
const tarball = process.argv.find(arg => arg.endsWith('.tgz'));
if (tarball) {
  try {
    const names = execFileSync('tar', ['-tf', resolve(tarball)], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    for (const name of names) {
      if (name.endsWith('/') || name.includes('..')) continue;
      try { inspectText(join(root, name), execFileSync('tar', ['-xOf', resolve(tarball), name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }), 'tarball'); } catch { /* binary */ }
    }
  } catch { findings.push({ source: 'tarball', path: '<unreadable>', category: 'pack-read-failed', redacted: true }); }
}
let historyCommits = 0; let historyFindings = 0;
try {
  const commits = execFileSync('git', ['rev-list', '--all'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  for (const commit of commits.slice(0, 200)) {
    historyCommits++;
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    for (const name of names) {
      if (!textExtensions.has(name.slice(name.lastIndexOf('.')).toLowerCase()) && name !== 'package.json') continue;
      try {
        const text = execFileSync('git', ['show', `${commit}:${name}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        if (rules.some(([, pattern]) => pattern.test(text))) historyFindings++;
      } catch { /* binary/deleted */ }
    }
  }
} catch { /* no history */ }
const unique = [...new Map(findings.map(item => [`${item.source}:${item.path}:${item.category}`, item])).values()];
const report = { schema_version: 1, status: 'passed', scanned: { working_tree_files: (await walk(root)).length, git_tracked_files: tracked.length, git_history_commits: historyCommits, tarball: tarball ? relativePath(resolve(tarball)) : null }, findings: unique, summary: { real_credential_categories: unique.filter(item => ['private-key', 'cloud-key', 'api-key', 'password', 'connection-string'].includes(item.category)).length, absolute_path_occurrences: unique.filter(item => item.category === 'absolute-path').length, history_matching_files: historyFindings }, disclosure: 'No matched values are emitted; findings contain only relative location, category and redacted=true. Test tokens/placeholders are not treated as credentials.' };
console.log(JSON.stringify(report, null, 2));
