import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { downloadReleaseAsset } from '../lib/cloud-download.mjs';

const url = 'https://github.com/example/forma/releases/download/v0.1.0/aios-plugin-forma.tgz';
const bytes = Buffer.from('fake-release-tarball');
const sha = createHash('sha256').update(bytes).digest('hex');
function response(body, status = 200, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers({ 'content-length': String(body.length), ...headers }), body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }) };
}
async function localHttp() {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/owner/repo/releases/download/v0.1.0/file.tgz` };
}
test('cloud download accepts a GitHub Release URL and verifies SHA-256 before returning a file', async () => {
  const work = await mkdtemp(join(tmpdir(), 'forma-cloud-'));
  try {
    const result = await downloadReleaseAsset({ packageUrl: url, sha256: sha, workRoot: work, fetchImpl: async () => response(bytes) });
    assert.equal(await readFile(result.path, 'utf8'), bytes.toString());
    assert.equal(result.sha256, sha); assert.equal(result.final_url, url); assert.equal(result.bytes, bytes.length);
    await rm(result.temp_dir, { recursive: true, force: true });
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('cloud download rejects a missing or mismatched digest without leaving a temp file', async () => {
  const work = await mkdtemp(join(tmpdir(), 'forma-cloud-'));
  try {
    await assert.rejects(downloadReleaseAsset({ packageUrl: url, sha256: '0'.repeat(64), workRoot: work, fetchImpl: async () => response(bytes) }), /PACKAGE_SHA256_MISMATCH/);
    assert.equal((await readdir(work)).length, 0);
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('cloud download enforces max-download-bytes while streaming', async () => {
  const work = await mkdtemp(join(tmpdir(), 'forma-cloud-'));
  try { await assert.rejects(downloadReleaseAsset({ packageUrl: url, sha256: sha, maxDownloadBytes: bytes.length - 1, workRoot: work, fetchImpl: async () => response(bytes) }), /PACKAGE_DOWNLOAD_TOO_LARGE/); }
  finally { await rm(work, { recursive: true, force: true }); }
});
test('local HTTP release-like URL is rejected before any network request', async () => {
  const local = await localHttp();
  const work = await mkdtemp(join(tmpdir(), 'forma-cloud-'));
  try { let contacted = false; await assert.rejects(downloadReleaseAsset({ packageUrl: local.url, sha256: sha, workRoot: work, fetchImpl: async () => { contacted = true; return response(bytes); } }), /PACKAGE_URL_NOT_GITHUB_RELEASE/); assert.equal(contacted, false); }
  finally { await rm(work, { recursive: true, force: true }); }
  await new Promise(resolve => local.server.close(resolve));
});
