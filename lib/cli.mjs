import { readFile, writeFile, mkdir, access, readdir, rm } from 'node:fs/promises';
import { isAbsolute, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { downloadReleaseAsset, cleanupDownloadedAsset } from './cloud-download.mjs';
import { resolvePnpm, pnpmEnvFragment } from './pnpm-resolve.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const PACKAGE_NAME = 'aios-plugin-forma';

// ---------------------------------------------------------------------------
// Error catalog: stable machine_code -> exit code + actionable Chinese hint.
// ---------------------------------------------------------------------------
const ERROR_CATALOG = {
  DSH_HOME_REQUIRED: { exit: 2, message: '缺少 --dsh-home。', action: '请提供 --dsh-home <绝对目录>；CLI 不会回退到个人 .dsh 目录。' },
  DSH_HOME_MUST_BE_ABSOLUTE: { exit: 2, message: '--dsh-home 必须是绝对路径。', action: '请改为绝对路径，例如 --dsh-home <绝对目录>。' },
  WORK_ROOT_REQUIRED: { exit: 2, message: '缺少 --work-root。', action: '请提供 --work-root <绝对目录>（可丢弃的工作目录）。' },
  WORK_ROOT_MUST_BE_ABSOLUTE: { exit: 2, message: '--work-root 必须是绝对路径。', action: '请改为绝对路径。' },
  PROFILE_REQUIRED: { exit: 2, message: '缺少 --profile。', action: '请提供 --profile <名称>，例如 --profile forma-test。' },
  DISPOSABLE_PROFILE_REQUIRED: { exit: 2, message: 'Profile 名称非法或是保留名称。', action: '请使用可丢弃 Profile 名称（如 forma-test）；default/production/prod/desktop 被禁止。' },
  PROFILE_OUTSIDE_DSH_HOME: { exit: 2, message: 'Profile 解析到了 DSH_HOME 之外。', action: '请检查 --dsh-home 与 --profile，Profile 必须位于 DSH_HOME/profiles 下。' },
  PACKAGE_URL_AND_SHA256_REQUIRED: { exit: 2, message: '--package-url 与 --sha256 必须同时提供。', action: '高安全模式需要固定 Release URL 和对应的 64 位十六进制摘要。' },
  SHA256_REQUIRED: { exit: 2, message: '--sha256 必须是 64 位十六进制。', action: '请从 Release notes 复制该资产的 SHA-256。' },
  MAX_DOWNLOAD_BYTES_INVALID: { exit: 2, message: '--max-download-bytes 必须是正整数。', action: '请给出一个正整数字节数，例如 52428800。' },
  PROFILE_PATCH_INVALID: { exit: 2, message: 'Profile 的 cordis.patch.yml 不是合法 YAML。', action: '请人工检查该 Profile 的 cordis.patch.yml 后再重试。' },
  UNKNOWN_COMMAND: { exit: 2, message: '未知命令。', action: '支持 install / inspect / uninstall；使用 --help 查看用法。' },
  UNKNOWN_ARGUMENT: { exit: 2, message: '未知参数。', action: '使用 --help 查看支持的参数。' },
  OPTION_VALUE_REQUIRED: { exit: 2, message: '选项缺少取值。', action: '形如 --dsh-home <目录> 的选项必须跟取值；使用 --help 查看用法。' },
  PNPM_REQUIRED: { exit: 10, message: '未找到 pnpm，DSH 无法安装插件依赖。', action: '已探测：PATH 无 pnpm 且当前 Node 未附带可用 corepack。安全方法二选一：使用附带 corepack 的 Node 24（本 CLI 会自动在 DSH_HOME 内建局部 shim，不改全局 PATH）；或 npm install -g pnpm（会写全局目录，需你自行接受）。检查命令：pnpm --version 与 corepack --version。' },
  PACKAGE_URL_NOT_GITHUB_RELEASE: { exit: 11, message: '只接受固定的 GitHub Release HTTPS URL。', action: 'URL 必须形如 https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.tgz，不接受 main/latest/分支归档。' },
  PACKAGE_URL_INVALID: { exit: 11, message: '--package-url 不是合法 URL。', action: '请粘贴 Release 页面中资产的完整 HTTPS 链接。' },
  PACKAGE_REDIRECT_NOT_GITHUB: { exit: 11, message: '下载重定向到了非 GitHub 主机，已拒绝。', action: '只信任 GitHub 及其资产源站；请确认 URL 来自官方 Release。' },
  PACKAGE_REDIRECT_LOCATION_MISSING: { exit: 11, message: 'GitHub 重定向响应缺少目标地址。', action: '请稍后重试；若持续出现请检查网络代理。' },
  PACKAGE_REDIRECT_LIMIT: { exit: 11, message: '下载重定向次数过多，已中止。', action: '请检查网络代理或稍后重试。' },
  PACKAGE_SHA256_MISMATCH: { exit: 12, message: '下载摘要不匹配，未调用 DSH，临时目录已清理。', action: '请核对 Release notes 中的 SHA-256 后重试；摘要不一致意味着资产可能被替换。' },
  PACKAGE_DOWNLOAD_TOO_LARGE: { exit: 12, message: '下载超过大小上限，未调用 DSH。', action: '如确认资产正常，可用 --max-download-bytes 提高上限。' },
  PACKAGE_DOWNLOAD_BODY_INVALID: { exit: 12, message: '下载响应体不可读取。', action: '请检查网络后重试。' },
  DSH_COMMAND_FAILED: { exit: 13, message: 'DSH 命令执行失败。', action: '上方最后一行是 DSH 的直接原因；Profile 已尝试回滚到安装前状态。' },
  PROFILE_CHANGED: { exit: 14, message: 'Profile 在安装期间被外部修改，未覆盖外部变更。', action: '请关闭正在使用该 Profile 的 DSH/编辑器后重试。' },
  INTEGRITY_MISMATCH: { exit: 15, message: '包文件完整性校验失败，已拒绝。', action: '安装包可能被篡改；请重新从固定 Release 下载并核对 SHA-256。' },
  RUNTIME_DIGEST_MISMATCH: { exit: 15, message: '运行时摘要校验失败，已拒绝。', action: '安装包可能被篡改；请重新从固定 Release 下载并核对 SHA-256。' },
  PLUGIN_IDENTITY_MISMATCH: { exit: 15, message: '插件身份校验失败，已拒绝。', action: '安装包可能被替换；请重新从固定 Release 下载。' },
  SOURCE_ROOT_REQUIRED: { exit: 16, message: '来源目录缺失或不可读。', action: '请提供存在的 --source-root <绝对目录>。扫描只需要读权限；直接源码生成另有审查信任边界，本 CLI 不写入该信任。' },
  SOURCE_UNTRUSTED: { exit: 16, message: '来源目录未获得审查信任。', action: '扫描不受限，但直接源码生成需要独立的 reviewed-source-root 记录；本 CLI 不写入该信任。' },
  PLUGIN_PATCH_DIGEST_MISSING: { exit: 15, message: '安装包缺少运行时摘要，已拒绝。', action: '安装包不完整；请重新从固定 Release 下载。' },
  CLEANUP_FAILED: { exit: 17, message: '残留清理失败。', action: '主操作结果如上；请手动删除残留目录后重试。' },
};

export class CliError extends Error {
  constructor(code, extras = {}) {
    const entry = ERROR_CATALOG[code] ?? {};
    super(extras.message ?? entry.message ?? code);
    this.machineCode = code;
    this.exitCode = extras.exitCode ?? entry.exit ?? 1;
    this.action = extras.action ?? entry.action ?? null;
    this.detail = extras.detail ?? null;
    this.residue = extras.residue ?? null;
    this.rolledBack = extras.rolledBack ?? null;
  }
}

function asCliError(error) {
  if (error instanceof CliError) return error;
  const raw = String(error?.message ?? error ?? 'UNKNOWN');
  const match = raw.match(/^([A-Z][A-Z0-9_]{2,})(?::([\s\S]*))?$/);
  const code = match ? match[1] : 'UNKNOWN_ERROR';
  const detail = match?.[2] ? scrub(match[2]).slice(0, 300) : (match ? null : scrub(raw).slice(0, 300));
  const cli = new CliError(ERROR_CATALOG[code] ? code : 'UNKNOWN_ERROR', { detail });
  cli.detail = cli.detail ?? detail;
  if (error?.stderr !== undefined) cli.dshStderr = error.stderr;
  if (error?.stdout !== undefined) cli.dshStdout = error.stdout;
  return cli;
}

// ---------------------------------------------------------------------------
// Redaction helpers: never leak signed URLs, tokens or environment values.
// ---------------------------------------------------------------------------
export function scrub(text) {
  return String(text ?? '')
    .replace(/https:\/\/objects\.githubusercontent\.com\/\S+/g, 'https://objects.githubusercontent.com/<redacted>')
    .replace(/((?:X-Amz-[A-Za-z-]+|[Ss]ignature|[Tt]oken|access_token|sig)=)[^\s&"']+/g, '$1<redacted>');
}

export function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.hostname === 'github.com' && !url.search && !url.hash) return url.href;
    return `${url.origin}${url.pathname}<redacted-query>`;
  } catch { return '<invalid-url>'; }
}

function redactShimPath(shimDir, home) {
  if (!shimDir) return null;
  return shimDir.startsWith(home) ? '<dsh-home>' + shimDir.slice(home.length) : '<forma-shim>';
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 16 ? `${sha.slice(0, 8)}...${sha.slice(-5)}` : (sha ?? null);
}

function lastLine(text) {
  const lines = scrub(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : null;
}

// ---------------------------------------------------------------------------
// Minimal Chinese help (no ANSI, no emoji; flags are the stable contract).
// ---------------------------------------------------------------------------
const USAGE = `用法：
  aios-plugin-forma install --dsh-home <绝对目录> --profile <名称> --work-root <绝对目录> --source-root <绝对目录>
                            [--package-url <GitHub-Release-URL> --sha256 <64位十六进制> --max-download-bytes <字节数>]
  aios-plugin-forma inspect --dsh-home <绝对目录> --profile <名称>
  aios-plugin-forma uninstall --dsh-home <绝对目录> --profile <名称>
  aios-plugin-forma --version
  aios-plugin-forma --help`;

const HELP = `aios-plugin-forma ${packageJson.version} · AIOS 自构建 DSH 插件

${USAGE}

输出模式：
  默认        简洁中文提示（[OK]/[INFO]/[WARN]/[ERROR]，无颜色无表情）
  --json      只输出一份稳定 JSON，供脚本使用
  --verbose   额外把 DSH/pnpm 原始诊断输出到 stderr
  --plain     装饰字符强制为纯 ASCII

安全约束：
  --dsh-home、--profile、--work-root、--source-root 始终显式必填；
  CLI 只操作指定的可丢弃 Profile，绝不回退到个人 .dsh 目录；
  --package-url 只接受固定 GitHub Release 资产，下载后先校验 SHA-256 再调用 DSH；
  pnpm 缺失时自动在用户指定的 DSH_HOME 内建 corepack 局部 shim，不修改全局 PATH。
`;

// ---------------------------------------------------------------------------
// Argument parsing. Boolean flags are scanned first so that even parse errors
// honour the requested output mode.
// ---------------------------------------------------------------------------
const BOOLEAN_FLAGS = new Set(['json', 'verbose', 'plain']);
function scanModes(argv) {
  return { json: argv.includes('--json'), verbose: argv.includes('--verbose'), plain: argv.includes('--plain') };
}
function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--help' || item === '-h') options.help = true;
    else if (item === '--version' || item === '-v') options.version = true;
    else if (item.startsWith('--')) {
      const key = item.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { options[key] = true; continue; }
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new CliError('OPTION_VALUE_REQUIRED', { detail: `选项 --${key} 缺少取值。` });
      options[key] = value;
    } else if (!options.command) options.command = item;
    else throw new CliError('UNKNOWN_ARGUMENT', { detail: `无法识别的参数：${item}` });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Path / profile safety guards (unchanged semantics from v0.1.1).
// ---------------------------------------------------------------------------
function explicitDir(value, name) {
  if (typeof value !== 'string') throw new CliError(`${name}_REQUIRED`);
  if (!isAbsolute(value)) throw new CliError(`${name}_MUST_BE_ABSOLUTE`);
  return resolve(value);
}
function profileDir(home, profile) {
  if (typeof profile !== 'string' || profile.length === 0) throw new CliError('PROFILE_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || /^(default|production|prod|desktop)$/i.test(profile)) throw new CliError('DISPOSABLE_PROFILE_REQUIRED');
  const dir = resolve(home, 'profiles', profile);
  const rel = relative(home, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new CliError('PROFILE_OUTSIDE_DSH_HOME');
  return dir;
}

// ---------------------------------------------------------------------------
// DSH invocation. The pnpm resolution only ever enters this child-process env.
// ---------------------------------------------------------------------------
function dshEnv(home, resolution) {
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, COMSPEC: process.env.ComSpec, PATHEXT: process.env.PATHEXT, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  const fragment = pnpmEnvFragment(resolution, home);
  return fragment ? { ...env, ...fragment } : env;
}
function realRunDsh(home, args, cwd, env) {
  const dshBin = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [dshBin, ...args], { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', code => code === 0 ? resolveRun({ code, stdout, stderr }) : rejectRun(Object.assign(new Error(`DSH_COMMAND_FAILED:${code}`), { code, stdout, stderr })));
  });
}

// ---------------------------------------------------------------------------
// Profile patch helpers.
// ---------------------------------------------------------------------------
async function readPatch(file) {
  try { const text = await readFile(file, 'utf8'); return { text, value: yaml.load(text) ?? [] }; }
  catch (error) { if (error.code === 'ENOENT') return { text: '', value: [] }; throw new CliError('PROFILE_PATCH_INVALID', { detail: scrub(error.message) }); }
}
function formaRow(config) { return { id: 'forma', name: PACKAGE_NAME, config }; }
function findFormaRow(value) {
  if (!Array.isArray(value)) return null;
  let found = null;
  for (const layer of value) for (const entry of (Array.isArray(layer?.insert) ? layer.insert : [])) if (entry?.id === 'forma') found = entry;
  return found;
}
function sameConfig(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) if (String(a?.[key]) !== String(b?.[key])) return false;
  return true;
}
function appendOverlay(value, row) {
  const layers = Array.isArray(value) ? value.map(layer => ({ ...layer })) : [];
  layers.push({ insert: [row] });
  return layers;
}
function removeForma(value) {
  return (Array.isArray(value) ? value : []).map(layer => ({ ...layer, insert: Array.isArray(layer.insert) ? layer.insert.filter(entry => entry.id !== 'forma') : layer.insert })).filter(layer => !Array.isArray(layer.insert) || layer.insert.length > 0);
}
async function ensureProfile(dir) {
  await mkdir(dir, { recursive: true });
  try { await access(join(dir, 'package.json')); }
  catch { await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-forma-disposable', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } }, null, 2) + '\n'); }
  try { await access(join(dir, 'cordis.patch.yml')); }
  catch { await writeFile(join(dir, 'cordis.patch.yml'), '[]\n'); }
}
async function pathExists(path) { try { await access(path); return true; } catch { return false; } }
async function runtimeDigest() {
  const text = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8');
  return text.match(/runtimeDigest:\s*["']?([^\s"']+)/)?.[1];
}
async function readDeclaredToolCount(dir) {
  for (const base of [join(dir, 'node_modules', PACKAGE_NAME), packageRoot]) {
    try {
      const spec = JSON.parse(await readFile(join(base, 'specs', 'tools.json'), 'utf8'));
      if (Array.isArray(spec.tools)) return spec.tools.length;
    } catch { /* try next source */ }
  }
  return null;
}
async function readInstalledVersion(dir) {
  try { return JSON.parse(await readFile(join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8')).version ?? null; }
  catch { return null; }
}
async function readInstallRecord(dir) {
  try { return JSON.parse(await readFile(join(dir, 'forma-install-record.json'), 'utf8')); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// DSH failure mapping: pnpm missing / integrity rejection / generic failure.
// ---------------------------------------------------------------------------
function mapDshFailure(error, extras = {}) {
  const stderr = String(error?.stderr ?? '');
  const integrity = stderr.match(/INTEGRITY_MISMATCH|RUNTIME_DIGEST_MISMATCH|PLUGIN_IDENTITY_MISMATCH/);
  if (integrity) return new CliError(integrity[0], { detail: lastLine(stderr), ...extras });
  if (/pnpm/i.test(stderr) && /ENOENT|not found|not recognized|command not found|不是内部或外部命令|无法识别/i.test(stderr)) {
    return new CliError('PNPM_REQUIRED', { detail: lastLine(stderr), ...extras });
  }
  return new CliError('DSH_COMMAND_FAILED', { detail: lastLine(stderr) ?? scrub(error.message), ...extras });
}

// ---------------------------------------------------------------------------
// Commands. Each returns { payload, lines } — payload feeds --json, lines feed
// the default human mode. Neither contains secrets or signed URLs.
// Wording rule: install only verifies the package and the profile config; it
// never connects to a running DSH host, so output must not claim runtime
// health or activated tools.
// ---------------------------------------------------------------------------
async function install(options, ctx) {
  const home = explicitDir(options['dsh-home'], 'DSH_HOME');
  const dir = profileDir(home, options.profile);
  const workRoot = explicitDir(options['work-root'], 'WORK_ROOT');
  if (typeof options['source-root'] !== 'string') throw new CliError('SOURCE_ROOT_REQUIRED', { message: '缺少 --source-root。' });
  if (!isAbsolute(options['source-root'])) throw new CliError('SOURCE_ROOT_REQUIRED', { message: '--source-root 必须是绝对路径。' });
  const sourceRoot = resolve(options['source-root']);
  if (!await pathExists(sourceRoot)) throw new CliError('SOURCE_ROOT_REQUIRED', { message: '来源目录不存在或不可读。', detail: sourceRoot });
  await mkdir(workRoot, { recursive: true });
  if ((options['package-url'] && !options.sha256) || (!options['package-url'] && options.sha256)) throw new CliError('PACKAGE_URL_AND_SHA256_REQUIRED');

  let download = null;
  let result = null;
  try {
    if (options['package-url']) download = await ctx.download({ packageUrl: options['package-url'], sha256: options.sha256, maxDownloadBytes: options['max-download-bytes'], workRoot });
    const packageSpec = download?.path ?? packageRoot;
    await ensureProfile(dir);
    const patchFile = join(dir, 'cordis.patch.yml');
    const before = await readPatch(patchFile);
    const config = { runtimeDigest: await runtimeDigest(), workRoot, sourceRootsJson: JSON.stringify([sourceRoot]), reviewedSourceRootsJson: JSON.stringify([]), timeoutMs: 15000 };
    if (!config.runtimeDigest) throw new CliError('PLUGIN_PATCH_DIGEST_MISSING');

    const existing = findFormaRow(before.value);
    const installedBefore = await readInstalledVersion(dir);
    const declaredTools = await readDeclaredToolCount(dir);
    if (existing && sameConfig(existing.config, config) && installedBefore === packageJson.version) {
      const recordPath = join(dir, 'forma-install-record.json');
      const record = await readInstallRecord(dir);
      result = { status: 'already-installed', version: installedBefore, declaredTools, recordPath: await pathExists(recordPath) ? recordPath : null, pnpm: record?.pnpm ?? null };
    } else {
      if (ctx.hooks?.beforePatchWrite) await ctx.hooks.beforePatchWrite();
      const currentText = await readFile(patchFile, 'utf8').catch(() => null);
      if (currentText !== null && currentText !== before.text) throw new CliError('PROFILE_CHANGED', { detail: `Profile 文件：${patchFile}` });
      // pnpm is resolved only when DSH will actually run; a shim lives inside
      // the caller-specified DSH_HOME and enters only the DSH child env.
      const pnpm = await ctx.resolvePnpm({ dshHome: home });
      const env = dshEnv(home, pnpm);
      const nextPatch = yaml.dump(appendOverlay(removeForma(before.value), formaRow(config)));
      await writeFile(patchFile, nextPatch);
      let dshResult;
      try {
        dshResult = await ctx.runDsh(home, ['plugin', '--profile', options.profile, 'install', packageSpec, '--config.ignore-scripts=true', '--yes'], home, env);
        ctx.verbose(`[dsh install stdout]\n${dshResult.stdout.trim()}\n[dsh install stderr]\n${dshResult.stderr.trim()}`);
        const dump = await ctx.runDsh(home, ['--profile', options.profile, '--dump-config'], home, env);
        ctx.verbose(`[dsh dump-config stdout]\n${dump.stdout.trim()}\n[dsh dump-config stderr]\n${dump.stderr.trim()}`);
      } catch (error) {
        let rolledBack = false;
        try { await ctx.runDsh(home, ['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME, '--yes'], home, env); } catch { /* best effort rollback */ }
        const afterText = await readFile(patchFile, 'utf8').catch(() => null);
        if (afterText === nextPatch) { await writeFile(patchFile, before.text || '[]\n'); rolledBack = true; }
        throw mapDshFailure(error, { rolledBack });
      }
      const version = (await readInstalledVersion(dir)) ?? packageJson.version;
      const record = { schema_version: 1, package_name: PACKAGE_NAME, version, requested_url: download?.requested_url ?? null, final_url: redactUrl(download?.final_url), sha256: download?.sha256 ?? null, bytes: download?.bytes ?? null, pnpm: { provider: pnpm.provider, version: pnpm.version, shim_path: pnpm.shimDir ?? null }, result: { status: 'installed', dsh_exit_code: dshResult.code, dsh_output: scrub(dshResult.stdout).trim() }, recorded_at: new Date().toISOString() };
      const recordPath = join(dir, 'forma-install-record.json');
      await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
      result = { status: existing ? 'updated' : 'installed', version, declaredTools: await readDeclaredToolCount(dir), recordPath, installedBefore, pnpm };
    }
  } finally {
    if (download) {
      try { await ctx.cleanup(download); }
      catch (error) {
        if (result) throw new CliError('CLEANUP_FAILED', { message: '安装已成功，但临时下载目录清理失败。', detail: scrub(error.message), residue: download.temp_dir ?? null });
        // primary failure wins; residue is reported through the primary error
      }
    }
  }

  const inspectCommand = `aios-plugin-forma inspect --dsh-home "${home}" --profile ${options.profile}`;
  const uninstallCommand = `aios-plugin-forma uninstall --dsh-home "${home}" --profile ${options.profile}`;
  const nextSteps = [
    `启动/重启 DSH 并打开 ${options.profile} Profile`,
    '在 DSH 中调用 forma_source_snapshot 扫描项目',
    `查看状态：${inspectCommand}`,
  ];
  const pnpmPayload = result.pnpm ? { provider: result.pnpm.provider, version: result.pnpm.version, shim_path_redacted: redactShimPath(result.pnpm.shimDir ?? result.pnpm.shim_path ?? null, home) } : null;
  const payload = {
    schema_version: 1, command: 'install', status: result.status, package: PACKAGE_NAME,
    version: result.version, profile: options.profile, dsh_home: home, work_root: workRoot, source_root: sourceRoot,
    runtime_digest: await runtimeDigest(), requested_url: download?.requested_url ?? null,
    final_url: redactUrl(download?.final_url), sha256: download?.sha256 ?? null, bytes: download?.bytes ?? null,
    configuration_status: 'matched', runtime_health: 'not_checked',
    declared_tool_count: result.declaredTools, pnpm: pnpmPayload,
    next_steps: nextSteps, uninstall_command: uninstallCommand,
    install_record_path: result.recordPath ?? null, error: null,
  };

  const lines = ['Forma · AIOS 自构建插件'];
  if (download) {
    lines.push('[OK] 下载完成', `[OK] SHA-256 校验通过：${shortSha(download.sha256)}`);
  } else {
    lines.push('[INFO] 未提供 --package-url，使用当前包目录安装');
  }
  if (result.status === 'already-installed') lines.push(`[OK] 已是最新版本（${result.version}），配置未改变`);
  else if (result.status === 'updated') lines.push(`[OK] 插件包更新完成：${options.profile}（${result.installedBefore ?? '未知'} -> ${result.version}）`);
  else lines.push(`[OK] 插件包安装完成：${options.profile}`);
  lines.push('[OK] Profile 配置已写入，runtimeDigest 与当前 CLI 一致');
  if (result.declaredTools !== null) lines.push(`[INFO] 插件声明 Forma 工具：${result.declaredTools} 个`);
  else lines.push('[WARN] 未能读取插件声明的工具数量');
  lines.push('[INFO] 启动/重启 DSH 后工具才会激活；本命令未连接运行中的 DSH');
  if (result.pnpm) lines.push(`[INFO] pnpm 解析：${result.pnpm.provider === 'path' ? `PATH（${result.pnpm.version ?? '版本未知'}）` : `corepack 局部 shim（pnpm ${result.pnpm.version}，位于 DSH_HOME 内，不改全局 PATH）`}`);
  lines.push('', `DSH_HOME：${home}`, `工作目录：${workRoot}`, '', '下一步：', ...nextSteps.map((step, index) => `  ${index + 1}. ${step}`), `卸载命令：${uninstallCommand}`);
  return { payload, lines };
}

async function inspect(options, ctx) {
  const home = explicitDir(options['dsh-home'], 'DSH_HOME');
  const dir = profileDir(home, options.profile);
  const patchFile = join(dir, 'cordis.patch.yml');
  const exists = await pathExists(dir);
  const patch = exists ? await readPatch(patchFile) : { text: '', value: [] };
  const row = findFormaRow(patch.value);
  const bundle = exists ? await pathExists(join(dir, 'node_modules', PACKAGE_NAME)) : false;
  const installCommand = `aios-plugin-forma install --dsh-home "${home}" --profile ${options.profile} --work-root <绝对目录> --source-root <绝对目录>`;

  if (!row && !bundle) {
    const payload = { schema_version: 1, command: 'inspect', status: 'not-installed', package: PACKAGE_NAME, version: null, profile: options.profile, dsh_home: home, runtime_digest: null, requested_url: null, final_url: null, sha256: null, bytes: null, configuration_status: 'absent', runtime_health: 'not_checked', declared_tool_count: null, source_roots: null, last_install: null, pnpm: null, install_command: installCommand, error: null };
    const lines = ['Forma 状态：未安装', `Profile：${options.profile}`, `DSH_HOME：${home}`, '', `安装命令：${installCommand}`];
    return { payload, lines };
  }

  const version = await readInstalledVersion(dir);
  const declaredTools = await readDeclaredToolCount(dir);
  let sourceRoots = null;
  try { sourceRoots = JSON.parse(row?.config?.sourceRootsJson ?? '[]').length; } catch { sourceRoots = null; }
  const currentDigest = await runtimeDigest();
  const configurationStatus = row?.config?.runtimeDigest ? (row.config.runtimeDigest === currentDigest ? 'matched' : 'mismatched') : 'absent';
  const record = await readInstallRecord(dir);
  const lastInstall = record ? { recorded_at: record.recorded_at ?? null, sha256: record.sha256 ?? null, version: record.version ?? null } : null;
  const pnpm = record?.pnpm ? { provider: record.pnpm.provider ?? null, version: record.pnpm.version ?? null, shim_path_redacted: redactShimPath(record.pnpm.shim_path ?? null, home) } : null;

  const payload = {
    schema_version: 1, command: 'inspect', status: 'installed', package: PACKAGE_NAME, version, profile: options.profile,
    dsh_home: home, runtime_digest: row?.config?.runtimeDigest ?? null, requested_url: null, final_url: null,
    sha256: lastInstall?.sha256 ?? null, bytes: null, configuration_status: configurationStatus, runtime_health: 'not_checked',
    declared_tool_count: declaredTools, source_roots: sourceRoots, last_install: lastInstall, pnpm, error: null,
  };
  const lines = [
    'Forma 状态：已安装',
    `插件版本：${version ?? '未知'}`,
    `Profile：${options.profile}`,
    `DSH_HOME：${home}`,
    `配置状态：${configurationStatus === 'matched' ? '摘要一致（runtimeDigest 与当前 CLI 一致）' : configurationStatus === 'mismatched' ? '摘要与当前 CLI 不一致（插件与 CLI 版本可能不同）' : '无摘要记录'}`,
    '运行状态：未检测（当前命令未连接正在运行的 DSH）',
  ];
  if (declaredTools !== null) lines.push(`插件声明 Forma 工具：${declaredTools} 个`);
  if (sourceRoots !== null) lines.push(`来源根目录：${sourceRoots} 个（只读）`);
  if (pnpm) lines.push(`pnpm：${pnpm.provider === 'path' ? `PATH（${pnpm.version ?? '版本未知'}）` : `corepack 局部 shim（pnpm ${pnpm.version ?? '未知'}）`}`);
  lines.push(lastInstall ? `最近安装：${lastInstall.recorded_at ?? '未知时间'} / ${lastInstall.sha256 ? 'sha256 ' + shortSha(lastInstall.sha256) : '无摘要记录'}` : '最近安装：无记录（可能由旧版本 CLI 安装）');
  return { payload, lines };
}

async function uninstall(options, ctx) {
  const home = explicitDir(options['dsh-home'], 'DSH_HOME');
  const dir = profileDir(home, options.profile);
  const patchFile = join(dir, 'cordis.patch.yml');
  const exists = await pathExists(dir);
  const patch = exists ? await readPatch(patchFile) : { text: '', value: [] };
  const row = findFormaRow(patch.value);
  const bundle = exists ? await pathExists(join(dir, 'node_modules', PACKAGE_NAME)) : false;

  const payload = { schema_version: 1, command: 'uninstall', status: null, package: PACKAGE_NAME, version: null, profile: options.profile, dsh_home: home, runtime_digest: null, requested_url: null, final_url: null, sha256: null, bytes: null, configuration_status: null, runtime_health: 'not_checked', declared_tool_count: null, cleaned_temp_dirs: null, pnpm: null, error: null };

  if (!row && !bundle) {
    payload.status = 'already-uninstalled';
    const lines = ['Forma · 卸载', `[INFO] Profile ${options.profile} 未安装 ${PACKAGE_NAME}，无需卸载（already-uninstalled）`, '', `Profile：${options.profile}`, `DSH_HOME：${home}`];
    return { payload, lines };
  }

  // pnpm resolves exactly like install: an existing shim inside this DSH_HOME
  // is reused, or rebuilt from the Node-bundled corepack — the user never
  // edits PATH manually.
  const pnpm = await ctx.resolvePnpm({ dshHome: home });
  const env = dshEnv(home, pnpm);
  payload.pnpm = { provider: pnpm.provider, version: pnpm.version, shim_path_redacted: redactShimPath(pnpm.shimDir ?? null, home) };
  try {
    const removed = await ctx.runDsh(home, ['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME, '--yes'], home, env).catch(error => {
      if (/not found|missing|未安装|not installed/i.test(String(error?.stderr ?? ''))) return null;
      throw error;
    });
    if (removed) ctx.verbose(`[dsh remove stdout]\n${removed.stdout.trim()}\n[dsh remove stderr]\n${removed.stderr.trim()}`);
  } catch (error) {
    throw mapDshFailure(error);
  }
  if (exists) await writeFile(patchFile, yaml.dump(removeForma(patch.value)));

  const residue = [];
  if (await pathExists(join(dir, 'node_modules', PACKAGE_NAME))) residue.push(join(dir, 'node_modules', PACKAGE_NAME));
  const after = exists ? await readPatch(patchFile) : { value: [] };
  if (findFormaRow(after.value)) residue.push(patchFile);

  // Temporary download leftovers: only claim cleanup for directories that
  // actually existed under the recorded work root.
  let cleanedTempDirs = 0;
  const workRoot = row?.config?.workRoot;
  if (typeof workRoot === 'string') {
    let entries = [];
    try { entries = await readdir(workRoot); } catch { entries = []; }
    for (const entry of entries.filter(name => name.startsWith('.forma-download-'))) {
      const target = join(workRoot, entry);
      try { await rm(target, { recursive: true, force: true }); cleanedTempDirs++; }
      catch { residue.push(target); }
    }
  }
  payload.cleaned_temp_dirs = cleanedTempDirs;
  if (residue.length > 0) throw new CliError('CLEANUP_FAILED', { message: '卸载未完全完成，存在残留。', residue: residue.join('；'), action: '请手动删除残留路径，然后重新运行 uninstall 确认。' });

  payload.status = 'uninstalled';
  const lines = [
    'Forma · 卸载',
    '[INFO] 如 DSH 正在运行，Forma Worker 将随 Profile 重启完全停止',
    `[OK] 已移除 ${PACKAGE_NAME} Bundle`,
    '[OK] DSH Profile 配置已恢复',
    cleanedTempDirs > 0 ? `[OK] 已清理临时下载目录：${cleanedTempDirs} 个` : '[INFO] 无临时下载目录残留（不适用）',
    '',
    `Profile：${options.profile}`,
    `DSH_HOME：${home}`,
  ];
  return { payload, lines };
}

// ---------------------------------------------------------------------------
// Entry point: mode-aware rendering for success and failure.
// ---------------------------------------------------------------------------
function decorate(text, plain) {
  return plain ? text.replaceAll('·', '-').replaceAll('：', ': ') : text;
}

export async function runCli(argv, deps = {}) {
  const modes = scanModes(argv);
  const out = deps.out ?? (line => process.stdout.write(line + '\n'));
  const err = deps.err ?? (line => process.stderr.write(line + '\n'));
  const ctx = {
    runDsh: deps.runDsh ?? realRunDsh,
    download: deps.download ?? downloadReleaseAsset,
    cleanup: deps.cleanup ?? cleanupDownloadedAsset,
    resolvePnpm: deps.resolvePnpm ?? resolvePnpm,
    hooks: deps.hooks ?? {},
    verbose: line => { if (modes.verbose) err(line); },
  };
  const emitJson = payload => out(JSON.stringify(payload));
  const emitError = error => {
    const cli = asCliError(error);
    if (modes.json) {
      emitJson({ schema_version: 1, command: deps.commandName ?? null, status: 'error', package: PACKAGE_NAME, version: packageJson.version, profile: null, dsh_home: null, runtime_digest: null, requested_url: null, final_url: null, sha256: null, bytes: null, error: { machine_code: cli.machineCode, message: cli.message, action: cli.action, detail: cli.detail, residue: cli.residue, exit_code: cli.exitCode } });
    } else {
      err(decorate(`[ERROR] ${cli.message}（${cli.machineCode}）`, modes.plain));
      if (cli.detail) err(decorate(`  原因：${cli.detail}`, modes.plain));
      if (cli.rolledBack === true) err(decorate('  已回滚：Profile 恢复到安装前状态。', modes.plain));
      if (cli.rolledBack === false && cli.machineCode === 'DSH_COMMAND_FAILED') err(decorate('  [WARN] 回滚未完成：Profile 在安装期间被外部修改，未覆盖外部变更。', modes.plain));
      if (cli.residue) err(decorate(`  残留路径：${cli.residue}`, modes.plain));
      if (cli.action) err(decorate(`  下一步：${cli.action}`, modes.plain));
      if (cli.exitCode === 2) err(decorate(USAGE + '\n使用 --help 查看完整说明。', modes.plain));
    }
    return cli.exitCode;
  };

  let options;
  try {
    options = parse(argv);
  } catch (error) {
    return emitError(error);
  }

  try {
    if (options.help || (!options.command && !options.version)) {
      if (modes.json) emitJson({ schema_version: 1, command: 'help', status: 'ok', package: PACKAGE_NAME, version: packageJson.version, usage: USAGE, error: null });
      else out(decorate(HELP.trimEnd(), modes.plain));
      return 0;
    }
    if (options.version) {
      if (modes.json) emitJson({ schema_version: 1, command: 'version', status: 'ok', package: PACKAGE_NAME, version: packageJson.version, error: null });
      else out(packageJson.version);
      return 0;
    }
    if (!['install', 'inspect', 'uninstall'].includes(options.command)) throw new CliError('UNKNOWN_COMMAND', { detail: `无法识别的命令：${options.command}` });
    deps.commandName = options.command;
    if (!options['dsh-home']) throw new CliError('DSH_HOME_REQUIRED');
    const command = options.command === 'install' ? install : options.command === 'inspect' ? inspect : uninstall;
    const { payload, lines } = await command(options, ctx);
    if (modes.json) emitJson(payload);
    else for (const line of lines) out(decorate(line, modes.plain));
    return 0;
  } catch (error) {
    return emitError(error);
  }
}

export const __testing = { ERROR_CATALOG, parse, scanModes, shortSha, lastLine, sameConfig, findFormaRow, dshEnv };
