import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../lib/cli.mjs';

const PACKAGE = 'aios-plugin-forma';
const RELEASE_URL = 'https://github.com/BioAIEvolu/aios-plugin-forma/releases/download/v0.2.0/aios-plugin-forma-0.2.0.tgz';
const SIGNED_URL = 'https://objects.githubusercontent.com/github-production-release-asset/61abc/def?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=SECRET123&X-Amz-Expires=300';
const SHA = 'a'.repeat(64);
const WRONG_SHA_ERROR = new Error(`PACKAGE_SHA256_MISMATCH:${'b'.repeat(64)}`);

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'forma-cli-'));
  const home = join(base, 'dsh-home');
  const work = join(base, 'work');
  const source = join(base, 'source');
  await mkdir(source, { recursive: true });
  const dir = join(home, 'profiles', 'forma-test');
  const calls = [];
  const io = { out: [], err: [] };
  const deps = {
    out: line => io.out.push(line),
    err: line => io.err.push(line),
    runDsh: async (_home, args) => {
      calls.push(args);
      if (args.includes('install')) await simulateInstalled(dir);
      if (args.includes('remove')) await rm(join(dir, 'node_modules', PACKAGE), { recursive: true, force: true });
      return { code: 0, stdout: 'dsh raw diagnostic line', stderr: '' };
    },
    download: async ({ workRoot }) => {
      const tempDir = await mkdtemp(join(workRoot, '.forma-download-'));
      return { path: join(tempDir, 'pkg.tgz'), requested_url: RELEASE_URL, final_url: SIGNED_URL, sha256: SHA, bytes: 123, temp_dir: tempDir };
    },
    cleanup: async download => { await rm(download.temp_dir, { recursive: true, force: true }); },
  };
  const installArgs = ['install', '--dsh-home', home, '--profile', 'forma-test', '--work-root', work, '--source-root', source, '--package-url', RELEASE_URL, '--sha256', SHA];
  return { base, home, work, source, dir, calls, io, deps, installArgs, cleanup: () => rm(base, { recursive: true, force: true }) };
}
async function simulateInstalled(dir) {
  const specDir = join(dir, 'node_modules', PACKAGE, 'specs');
  await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, 'tools.json'), JSON.stringify({ schema_version: 1, tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }));
  await writeFile(join(dir, 'node_modules', PACKAGE, 'package.json'), JSON.stringify({ name: PACKAGE, version: '0.2.0' }));
}
const text = io => io.out.join('\n');
const errText = io => io.err.join('\n');
async function pathExists(path) { try { await access(path); return true; } catch { return false; } }

test('install success prints actionable Chinese status with next steps and uninstall command', async () => {
  const f = await fixture();
  try {
    const code = await runCli(f.installArgs, f.deps);
    assert.equal(code, 0);
    assert.equal(errText(f.io), '');
    const out = text(f.io);
    assert.match(out, /Forma · AIOS 自构建插件/);
    assert.match(out, /\[OK\] 下载完成/);
    assert.match(out, /\[OK\] SHA-256 校验通过：aaaaaaaa\.\.\.aaaaa/);
    assert.match(out, /\[OK\] 已安装到 DSH Profile：forma-test/);
    assert.match(out, /\[OK\] 运行时摘要校验通过/);
    assert.match(out, /\[OK\] Forma 工具已就绪：3 个/);
    assert.match(out, /下一步：/);
    assert.match(out, /forma_source_snapshot/);
    assert.match(out, /卸载命令：aios-plugin-forma uninstall --dsh-home /);
    assert.doesNotMatch(out + errText(f.io), /SECRET123|X-Amz-Expires=300/);
  } finally { await f.cleanup(); }
});

test('install --json prints one stable JSON document and redacts the signed final_url', async () => {
  const f = await fixture();
  try {
    const code = await runCli([...f.installArgs, '--json'], f.deps);
    assert.equal(code, 0);
    assert.equal(f.io.out.length, 1);
    assert.equal(errText(f.io), '');
    const payload = JSON.parse(f.io.out[0]);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.command, 'install');
    assert.equal(payload.status, 'installed');
    assert.equal(payload.package, PACKAGE);
    assert.equal(payload.version, '0.2.0');
    assert.equal(payload.profile, 'forma-test');
    assert.equal(payload.dsh_home, f.home);
    assert.equal(payload.requested_url, RELEASE_URL);
    assert.doesNotMatch(String(payload.final_url), /SECRET123|X-Amz/);
    assert.equal(payload.sha256, SHA);
    assert.equal(payload.bytes, 123);
    assert.equal(payload.tool_count, 3);
    assert.equal(payload.next_steps.length, 3);
    assert.match(payload.uninstall_command, /uninstall/);
    assert.equal(payload.error, null);
    assert.doesNotMatch(f.io.out[0], /SECRET123/);
  } finally { await f.cleanup(); }
});

test('repeated install is idempotent: already-installed, config unchanged, DSH not called again', async () => {
  const f = await fixture();
  try {
    assert.equal(await runCli(f.installArgs, f.deps), 0);
    const callsAfterFirst = f.calls.length;
    const io2 = { out: [], err: [] };
    const code = await runCli(f.installArgs, { ...f.deps, out: line => io2.out.push(line), err: line => io2.err.push(line) });
    assert.equal(code, 0);
    assert.equal(f.calls.length, callsAfterFirst, 'idempotent install must not invoke DSH');
    assert.match(text(io2), /已是最新版本（0\.2\.0），配置未改变/);
    const io3 = { out: [], err: [] };
    await runCli([...f.installArgs, '--json'], { ...f.deps, out: line => io3.out.push(line), err: line => io3.err.push(line) });
    assert.equal(JSON.parse(io3.out[0]).status, 'already-installed');
  } finally { await f.cleanup(); }
});

test('local install without --package-url announces the local package source', async () => {
  const f = await fixture();
  try {
    const args = ['install', '--dsh-home', f.home, '--profile', 'forma-test', '--work-root', f.work, '--source-root', f.source];
    const code = await runCli(args, f.deps);
    assert.equal(code, 0);
    assert.match(text(f.io), /使用当前包目录安装/);
    assert.doesNotMatch(text(f.io), /下载完成/);
  } finally { await f.cleanup(); }
});

test('inspect reports installed state with version, tools, source roots and last install', async () => {
  const f = await fixture();
  try {
    await runCli(f.installArgs, f.deps);
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line) };
    const code = await runCli(['inspect', '--dsh-home', f.home, '--profile', 'forma-test'], deps);
    assert.equal(code, 0);
    const out = text(io);
    assert.match(out, /Forma 状态：已安装/);
    assert.match(out, /插件版本：0\.2\.0/);
    assert.match(out, /Forma 工具：3 个/);
    assert.match(out, /来源根目录：1 个（只读）/);
    assert.match(out, /最近安装：/);
    const ioJson = { out: [], err: [] };
    await runCli(['inspect', '--dsh-home', f.home, '--profile', 'forma-test', '--json'], { ...deps, out: line => ioJson.out.push(line), err: line => ioJson.err.push(line) });
    const payload = JSON.parse(ioJson.out[0]);
    assert.equal(payload.status, 'installed');
    assert.equal(payload.tool_count, 3);
    assert.equal(payload.source_roots, 1);
    assert.equal(payload.last_install.sha256, SHA);
  } finally { await f.cleanup(); }
});

test('inspect on an empty profile reports not-installed without creating the profile', async () => {
  const f = await fixture();
  try {
    const code = await runCli(['inspect', '--dsh-home', f.home, '--profile', 'forma-test'], f.deps);
    assert.equal(code, 0);
    assert.match(text(f.io), /Forma 状态：未安装/);
    assert.match(text(f.io), /安装命令：aios-plugin-forma install/);
    assert.equal(await pathExists(f.dir), false, 'inspect must not create the profile');
    const ioJson = { out: [], err: [] };
    await runCli(['inspect', '--dsh-home', f.home, '--profile', 'forma-test', '--json'], { ...f.deps, out: line => ioJson.out.push(line), err: line => ioJson.err.push(line) });
    assert.equal(JSON.parse(ioJson.out[0]).status, 'not-installed');
  } finally { await f.cleanup(); }
});

test('uninstall removes the bundle and restores the profile; repeated uninstall is already-uninstalled with exit 0', async () => {
  const f = await fixture();
  try {
    await runCli(f.installArgs, f.deps);
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line) };
    const code = await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test'], deps);
    assert.equal(code, 0);
    const out = text(io);
    assert.match(out, /\[OK\] 已移除 aios-plugin-forma Bundle/);
    assert.match(out, /\[OK\] DSH Profile 配置已恢复/);
    const io2 = { out: [], err: [] };
    const callsBefore = f.calls.length;
    const code2 = await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test', '--json'], { ...deps, out: line => io2.out.push(line), err: line => io2.err.push(line) });
    assert.equal(code2, 0);
    assert.equal(JSON.parse(io2.out[0]).status, 'already-uninstalled');
    assert.equal(f.calls.length, callsBefore, 'already-uninstalled must not invoke DSH');
  } finally { await f.cleanup(); }
});

test('uninstall with residue fails with CLEANUP_FAILED, exit 17 and residue paths', async () => {
  const f = await fixture();
  try {
    await runCli(f.installArgs, f.deps);
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), runDsh: async () => ({ code: 0, stdout: '', stderr: '' }) };
    const code = await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test'], deps);
    assert.equal(code, 17);
    assert.match(errText(io), /CLEANUP_FAILED/);
    assert.match(errText(io), /残留路径：/);
    assert.match(errText(io), /node_modules/);
    assert.doesNotMatch(text(io), /\[OK\] 已移除/);
  } finally { await f.cleanup(); }
});

test('download validation failures map to exit 11/12 without ever calling DSH', async () => {
  for (const [thrown, exit, code] of [
    [new Error('PACKAGE_URL_NOT_GITHUB_RELEASE'), 11, 'PACKAGE_URL_NOT_GITHUB_RELEASE'],
    [WRONG_SHA_ERROR, 12, 'PACKAGE_SHA256_MISMATCH'],
    [new Error('PACKAGE_DOWNLOAD_TOO_LARGE'), 12, 'PACKAGE_DOWNLOAD_TOO_LARGE'],
  ]) {
    const f = await fixture();
    try {
      const io = { out: [], err: [] };
      const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), download: async () => { throw thrown; } };
      const actual = await runCli(f.installArgs, deps);
      assert.equal(actual, exit, code);
      assert.equal(f.calls.length, 0, `${code} must not invoke DSH`);
      assert.match(errText(io), new RegExp(code));
      assert.match(errText(io), /下一步：/);
    } finally { await f.cleanup(); }
  }
});

test('SHA-256 mismatch error reports that DSH was never called and temp dir was cleaned', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), download: async () => { throw WRONG_SHA_ERROR; } };
    assert.equal(await runCli(f.installArgs, deps), 12);
    assert.match(errText(io), /未调用 DSH，临时目录已清理/);
  } finally { await f.cleanup(); }
});

test('DSH failure maps pnpm-missing to exit 10, integrity rejection to exit 15, generic to exit 13 with rollback', async () => {
  const cases = [
    { stderr: 'spawn pnpm ENOENT', exit: 10, code: 'PNPM_REQUIRED', expect: /corepack/ },
    { stderr: 'boot failed\nRUNTIME_DIGEST_MISMATCH: host.mjs', exit: 15, code: 'RUNTIME_DIGEST_MISMATCH', expect: /重新从固定 Release 下载/ },
    { stderr: 'long stack\nfinal boom', exit: 13, code: 'DSH_COMMAND_FAILED', expect: /final boom/ },
  ];
  for (const item of cases) {
    const f = await fixture();
    try {
      const io = { out: [], err: [] };
      const failure = Object.assign(new Error('DSH_COMMAND_FAILED:1'), { code: 1, stdout: '', stderr: item.stderr });
      const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), runDsh: async (_home, args) => { f.calls.push(args); if (args.includes('remove')) return { code: 0, stdout: '', stderr: '' }; throw failure; } };
      assert.equal(await runCli(f.installArgs, deps), item.exit, item.code);
      assert.match(errText(io), new RegExp(item.code));
      assert.match(errText(io), item.expect);
      assert.ok(f.calls.some(args => args.includes('remove')), `${item.code} should attempt rollback`);
      if (item.exit === 13) {
        assert.match(errText(io), /已回滚/);
        assert.equal(await readFile(join(f.dir, 'cordis.patch.yml'), 'utf8'), '[]\n', 'patch must be restored after rollback');
      }
    } finally { await f.cleanup(); }
  }
});

test('external profile modification during install aborts with PROFILE_CHANGED exit 14', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = {
      ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line),
      hooks: { beforePatchWrite: async () => { await appendFile(join(f.dir, 'cordis.patch.yml'), '# external edit\n'); } },
    };
    const code = await runCli(f.installArgs, deps);
    assert.equal(code, 14);
    assert.match(errText(io), /PROFILE_CHANGED/);
    assert.match(errText(io), /未覆盖外部变更/);
    assert.equal(f.calls.length, 0, 'PROFILE_CHANGED must happen before any DSH call');
  } finally { await f.cleanup(); }
});

test('cleanup failure after a successful install reports both results with exit 17', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    let residue = null;
    const deps = {
      ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line),
      download: async ({ workRoot }) => {
        const tempDir = await mkdtemp(join(workRoot, '.forma-download-'));
        residue = tempDir;
        return { path: join(tempDir, 'pkg.tgz'), requested_url: RELEASE_URL, final_url: SIGNED_URL, sha256: SHA, bytes: 123, temp_dir: tempDir };
      },
      cleanup: async () => { throw new Error('EPERM: locked'); },
    };
    const code = await runCli(f.installArgs, deps);
    assert.equal(code, 17);
    assert.match(errText(io), /CLEANUP_FAILED/);
    assert.match(errText(io), /安装已成功/);
    assert.match(errText(io), /残留路径：/);
    if (residue) assert.ok(errText(io).includes(residue.replaceAll('\\', '\\')));
  } finally { await f.cleanup(); }
});

test('--verbose routes raw DSH diagnostics to stderr; default mode keeps stderr clean on success', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line) };
    assert.equal(await runCli([...f.installArgs, '--verbose'], deps), 0);
    assert.match(errText(io), /dsh raw diagnostic line/);
    assert.match(text(io), /\[OK\] 已安装到 DSH Profile/);
  } finally { await f.cleanup(); }
});

test('errors in --json mode are a single JSON document on stdout with machine_code and exit_code', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), download: async () => { throw new Error('PACKAGE_URL_NOT_GITHUB_RELEASE'); } };
    const code = await runCli([...f.installArgs, '--json'], deps);
    assert.equal(code, 11);
    assert.equal(io.out.length, 1);
    assert.equal(errText(io), '');
    const payload = JSON.parse(io.out[0]);
    assert.equal(payload.status, 'error');
    assert.equal(payload.error.machine_code, 'PACKAGE_URL_NOT_GITHUB_RELEASE');
    assert.equal(payload.error.exit_code, 11);
    assert.match(payload.error.action, /releases\/download/);
  } finally { await f.cleanup(); }
});

test('--plain forces ASCII decoration', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line) };
    assert.equal(await runCli([...f.installArgs, '--plain'], deps), 0);
    assert.match(text(io), /Forma - AIOS 自构建插件/);
    assert.doesNotMatch(text(io), /·/);
  } finally { await f.cleanup(); }
});

test('error output never leaks signed URLs, tokens or query secrets', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const failure = Object.assign(new Error('DSH_COMMAND_FAILED:1'), { code: 1, stdout: '', stderr: `GET ${SIGNED_URL} failed with token=SECRET123` });
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), runDsh: async (_home, args) => { if (args.includes('remove')) return { code: 0, stdout: '', stderr: '' }; throw failure; } };
    assert.equal(await runCli(f.installArgs, deps), 13);
    assert.doesNotMatch(text(io) + errText(io), /SECRET123|X-Amz-Signature=[^<\s]|token=[^<\s]/);
  } finally { await f.cleanup(); }
});
