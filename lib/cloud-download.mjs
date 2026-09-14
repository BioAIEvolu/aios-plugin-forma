import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const RELEASE_PATH = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/;
const GITHUB_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function validateGitHubReleaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PACKAGE_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.hostname !== 'github.com' || !RELEASE_PATH.test(url.pathname)) throw new Error('PACKAGE_URL_NOT_GITHUB_RELEASE');
  return url;
}
export function parseSha256(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('SHA256_REQUIRED');
  return value.toLowerCase();
}
function parseMaxBytes(value) {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('MAX_DOWNLOAD_BYTES_INVALID');
  return number;
}
async function readBody(response, maxBytes) {
  if (!response.ok) throw new Error(`PACKAGE_DOWNLOAD_HTTP_${response.status}`);
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('PACKAGE_DOWNLOAD_TOO_LARGE');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('PACKAGE_DOWNLOAD_BODY_INVALID');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('PACKAGE_DOWNLOAD_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, total);
}

/** Download a GitHub Release asset into an isolated temporary directory. */
export async function downloadReleaseAsset({ packageUrl, sha256, maxDownloadBytes, workRoot, fetchImpl = fetch }) {
  const requestedUrl = validateGitHubReleaseUrl(packageUrl);
  const expected = parseSha256(sha256);
  const maxBytes = parseMaxBytes(maxDownloadBytes);
  if (typeof workRoot !== 'string' || workRoot.length === 0) throw new Error('WORK_ROOT_REQUIRED');
  await mkdir(workRoot, { recursive: true });
  const tempDir = await mkdtemp(join(workRoot, '.forma-download-'));
  const fileName = basename(requestedUrl.pathname) || 'package.tgz';
  const filePath = join(tempDir, fileName);
  try {
    let current = requestedUrl;
    let response;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (current.protocol !== 'https:' || !GITHUB_HOSTS.has(current.hostname)) throw new Error('PACKAGE_REDIRECT_NOT_GITHUB');
      response = await fetchImpl(current, { redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('PACKAGE_REDIRECT_LOCATION_MISSING');
      current = new URL(location, current);
    }
    if (!response || [301, 302, 303, 307, 308].includes(response.status)) throw new Error('PACKAGE_REDIRECT_LIMIT');
    const bytes = await readBody(response, maxBytes);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`PACKAGE_SHA256_MISMATCH:${actual}`);
    await writeFile(filePath, bytes, { flag: 'wx' });
    return { path: filePath, requested_url: requestedUrl.href, final_url: current.href, sha256: actual, bytes: bytes.length, temp_dir: tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupDownloadedAsset(download) {
  if (download?.temp_dir) await rm(download.temp_dir, { recursive: true, force: true });
}
