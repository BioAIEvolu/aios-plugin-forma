import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
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
  const envs = [];
  const io = { out: [], err: [] };
  const deps = {
    out: line => io.out.push(line),
    err: line => io.err.push(line),
    runDsh: async (_home, args, _cwd, env) => {
      calls.push(args); envs.push(env);
      if (args.includes('install')) await simulateInstalled(dir);
      if (args.includes('remove')) await rm(join(dir, 'node_modules', PACKAGE), { recursive: true, force: true });
      return { code: 0, stdout: 'dsh raw diagnostic line', stderr: '' };
    },
    download: async ({ workRoot }) => {
      const tempDir = await mkdtemp(join(workRoot, '.forma-download-'));
      return { path: join(tempDir, 'pkg.tgz'), requested_url: RELEASE_URL, final_url: SIGNED_URL, sha256: SHA, bytes: 123, temp_dir: tempDir };
    },
    cleanup: async download => { await rm(download.temp_dir, { recursive: true, force: true }); },
    resolvePnpm: async () => ({ provider: 'path', version: '10.9.0', shimDir: null, corepackJs: null }),
  };
  const installArgs = ['install', '--dsh-home', home, '--profile', 'forma-test', '--work-root', work, '--source-root', source, '--package-url', RELEASE_URL, '--sha256', SHA];
  return { base, home, work, source, dir, calls, envs, io, deps, installArgs, cleanup: () => rm(base, { recursive: true, force: true }) };
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

test('install success prints honest package+config status with next steps and uninstall command', async () => {
  const f = await fixture();
  try {
    const code = await runCli(f.installArgs, f.deps);
    assert.equal(code, 0);
    assert.equal(errText(f.io), '');
    const out = text(f.io);
    assert.match(out, /Forma · AIOS 自构建插件/);
    assert.match(out, /\[OK\] 下载完成/);
    assert.match(out, /\[OK\] SHA-256 校验通过：aaaaaaaa\.\.\.aaaaa/);
    assert.match(out, /\[OK\] 插件包安装完成：forma-test/);
    assert.match(out, /\[OK\] Profile 配置已写入，runtimeDigest 与当前 CLI 一致/);
    assert.match(out, /\[INFO\] 插件声明 Forma 工具：3 个/);
    assert.match(out, /\[INFO\] 启动\/重启 DSH 后工具才会激活/);
    assert.match(out, /\[INFO\] pnpm 解析：PATH（10\.9\.0）/);
    assert.doesNotMatch(out, /工具已就绪|运行时摘要校验通过/);
    assert.match(out, /下一步：/);
    assert.match(out, /forma_source_snapshot/);
    assert.match(out, /卸载命令：aios-plugin-forma uninstall --dsh-home /);
    assert.doesNotMatch(out + errText(f.io), /SECRET123|X-Amz-Expires=300/);
  } finally { await f.cleanup(); }
});

test('install --json prints one stable JSON document with honest fields and redaction', async () => {
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
    assert.equal(payload.configuration_status, 'matched');
    assert.equal(payload.runtime_health, 'not_checked');
    assert.equal(payload.declared_tool_count, 3);
    assert.equal(payload.tool_count, undefined, 'deprecated name must not reappear');
    assert.deepEqual(payload.pnpm, { provider: 'path', version: '10.9.0', shim_path_redacted: null });
    assert.equal(payload.next_steps.length, 3);
    assert.match(payload.uninstall_command, /uninstall/);
    assert.equal(payload.error, null);
    assert.doesNotMatch(f.io.out[0], /SECRET123/);
    const record = JSON.parse(await readFile(join(f.dir, 'forma-install-record.json'), 'utf8'));
    assert.deepEqual(record.pnpm, { provider: 'path', version: '10.9.0', shim_path: null });
  } finally { await f.cleanup(); }
});

test('repeated install is idempotent: already-installed, config unchanged, DSH and pnpm resolver not called again', async () => {
  const f = await fixture();
  try {
    assert.equal(await runCli(f.installArgs, f.deps), 0);
    const callsAfterFirst = f.calls.length;
    let resolved = 0;
    const io2 = { out: [], err: [] };
    const code = await runCli(f.installArgs, { ...f.deps, out: line => io2.out.push(line), err: line => io2.err.push(line), resolvePnpm: async () => { resolved++; return { provider: 'path', version: '10.9.0', shimDir: null, corepackJs: null }; } });
    assert.equal(code, 0);
    assert.equal(f.calls.length, callsAfterFirst, 'idempotent install must not invoke DSH');
    assert.equal(resolved, 0, 'idempotent install must not resolve pnpm');
    assert.match(text(io2), /已是最新版本（0\.2\.0），配置未改变/);
    const io3 = { out: [], err: [] };
    await runCli([...f.installArgs, '--json'], { ...f.deps, out: line => io3.out.push(line), err: line => io3.err.push(line) });
    const payload = JSON.parse(io3.out[0]);
    assert.equal(payload.status, 'already-installed');
    assert.equal(payload.pnpm.provider, 'path', 'pnpm info echoed from the install record');
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

test('corepack shim resolution enters only the DSH child env; process.env.PATH untouched', async () => {
  const f = await fixture();
  try {
    const shimDir = join(f.home, '.forma', 'shims');
    const pathBefore = process.env.PATH;
    const deps = { ...f.deps, resolvePnpm: async () => ({ provider: 'corepack-shim', version: '12.3.4', shimDir, corepackJs: 'corepack.js' }) };
    const code = await runCli(f.installArgs, deps);
    assert.equal(code, 0);
    assert.equal(process.env.PATH, pathBefore, 'process.env.PATH must not be modified');
    assert.ok(f.envs.length >= 2, 'DSH install + dump-config captured');
    for (const env of f.envs) {
      assert.ok(env.PATH.startsWith(shimDir + delimiter), 'shim dir is prepended to the DSH child PATH');
      assert.ok(env.COREPACK_HOME.startsWith(f.home), 'corepack cache stays inside DSH_HOME');
    }
    assert.match(text(f.io), /corepack 局部 shim（pnpm 12\.3\.4/);
    const ioJson = { out: [], err: [] };
    const deps2 = { ...deps, out: line => ioJson.out.push(line), err: line => ioJson.err.push(line) };
    await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test', '--json'], deps2);
    const payload = JSON.parse(ioJson.out[0]);
    assert.equal(payload.status, 'uninstalled');
    assert.equal(payload.pnpm.provider, 'corepack-shim');
    assert.match(payload.pnpm.shim_path_redacted, /^<dsh-home>/, 'shim path is redacted in JSON');
    assert.doesNotMatch(JSON.stringify(payload), /SECRET123/);
  } finally { await f.cleanup(); }
});

test('uninstall resolves pnpm too (shim reuse) and never requires manual PATH edits', async () => {
  const f = await fixture();
  try {
    await runCli(f.installArgs, f.deps);
    let resolved = 0;
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), resolvePnpm: async () => { resolved++; return { provider: 'path', version: '10.9.0', shimDir: null, corepackJs: null }; } };
    const code = await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test'], deps);
    assert.equal(code, 0);
    assert.equal(resolved, 1, 'uninstall must resolve pnpm before calling DSH');
  } finally { await f.cleanup(); }
});

test('inspect reports installed state with configuration status and unchecked runtime', async () => {
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
    assert.match(out, /配置状态：摘要一致/);
    assert.match(out, /运行状态：未检测（当前命令未连接正在运行的 DSH）/);
    assert.match(out, /插件声明 Forma 工具：3 个/);
    assert.match(out, /来源根目录：1 个（只读）/);
    assert.match(out, /最近安装：/);
    assert.doesNotMatch(out, /运行时：健康/);
    const ioJson = { out: [], err: [] };
    await runCli(['inspect', '--dsh-home', f.home, '--profile', 'forma-test', '--json'], { ...deps, out: line => ioJson.out.push(line), err: line => ioJson.err.push(line) });
    const payload = JSON.parse(ioJson.out[0]);
    assert.equal(payload.status, 'installed');
    assert.equal(payload.configuration_status, 'matched');
    assert.equal(payload.runtime_health, 'not_checked');
    assert.equal(payload.declared_tool_count, 3);
    assert.equal(payload.tool_count, undefined);
    assert.equal(payload.source_roots, 1);
    assert.equal(payload.last_install.sha256, SHA);
    assert.equal(payload.pnpm.provider, 'path');
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
    const payload = JSON.parse(ioJson.out[0]);
    assert.equal(payload.status, 'not-installed');
    assert.equal(payload.configuration_status, 'absent');
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
    assert.match(out, /\[INFO\] 无临时下载目录残留（不适用）/, 'no leftovers -> honest not-applicable line');
    assert.doesNotMatch(out, /\[OK\] 临时下载目录已清理/);
    const io2 = { out: [], err: [] };
    const callsBefore = f.calls.length;
    const code2 = await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test', '--json'], { ...deps, out: line => io2.out.push(line), err: line => io2.err.push(line) });
    assert.equal(code2, 0);
    assert.equal(JSON.parse(io2.out[0]).status, 'already-uninstalled');
    assert.equal(f.calls.length, callsBefore, 'already-uninstalled must not invoke DSH');
  } finally { await f.cleanup(); }
});

test('uninstall actually cleans recorded temp download leftovers and says so', async () => {
  const f = await fixture();
  try {
    await runCli(f.installArgs, f.deps);
    const leftover = join(f.work, '.forma-download-stale');
    await mkdir(leftover, { recursive: true });
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line) };
    const code = await runCli(['uninstall', '--dsh-home', f.home, '--profile', 'forma-test'], deps);
    assert.equal(code, 0);
    assert.match(text(io), /\[OK\] 已清理临时下载目录：1 个/);
    assert.equal(await pathExists(leftover), false, 'leftover temp dir must be removed');
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

test('pnpm resolution failure maps to PNPM_REQUIRED exit 10 before any DSH call', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line), resolvePnpm: async () => { throw new Error('PNPM_REQUIRED:PATH 中未找到 pnpm，且当前 Node 未附带可用的 corepack'); } };
    const code = await runCli(f.installArgs, deps);
    assert.equal(code, 10);
    assert.equal(f.calls.length, 0, 'pnpm failure must precede any DSH call');
    assert.match(errText(io), /PNPM_REQUIRED/);
    assert.match(errText(io), /corepack/);
    assert.match(errText(io), /pnpm --version/);
    const ioJson = { out: [], err: [] };
    const code2 = await runCli([...f.installArgs, '--json'], { ...deps, out: line => ioJson.out.push(line), err: line => ioJson.err.push(line) });
    assert.equal(code2, 10);
    assert.equal(JSON.parse(ioJson.out[0]).error.machine_code, 'PNPM_REQUIRED');
  } finally { await f.cleanup(); }
});

test('DSH failure maps integrity rejection to exit 15, generic to exit 13 with rollback', async () => {
  const cases = [
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
    if (residue) assert.ok(errText(io).includes(residue));
  } finally { await f.cleanup(); }
});

test('--verbose routes raw DSH diagnostics to stderr; default mode keeps stderr clean on success', async () => {
  const f = await fixture();
  try {
    const io = { out: [], err: [] };
    const deps = { ...f.deps, out: line => io.out.push(line), err: line => io.err.push(line) };
    assert.equal(await runCli([...f.installArgs, '--verbose'], deps), 0);
    assert.match(errText(io), /dsh raw diagnostic line/);
    assert.match(text(io), /\[OK\] 插件包安装完成/);
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
