# aios-plugin-forma

[English](README.md) | 简体中文

`aios-plugin-forma` 是 AIOS 的自构建 DSH 插件（Bundle）。给定一个本地源码项目，它能
扫描源码、识别可复用的能力、从经过评审的选中项生成候选插件，并导出候选插件仓库——
全程通过版本化的 `forma_*` DTO 工具完成。所有源码检查与候选生成工作都委托给由
Supervisor 持有的子 Worker；Host 从不导入或执行源项目代码。

本仓库在 `core/` 下内嵌了所需的 Forma Core；不依赖任何 workspace core-root 环境变量、
AIOS 或开发用的 `forma/` 目录树。只有 `workRoot` 和调用方选定的 source root 会进入
DSH Profile。Worker 只读取已配置的 source root，只写入受管 work root。

## 安全模型

- **Worker 是进程边界，不是操作系统级的恶意代码沙箱。** Node 权限标志与子进程边界只是
  纵深防御。不要把 Forma 指向你自己都不敢运行的源码。
- `source-root` 是读取边界，不是源码审批。直接源码生成候选件还需要一份显式的
  reviewed-source-root 记录；随附的 CLI 不会写入这种审批，因此普通用户选定的源码只能
  被扫描，无法用于直接源码生成。
- 默认路径是"仅提案"：候选生成会创建 tarball 并输出报告，但绝不会把生成的插件安装进
  正在运行的 Profile。
- 本地运行时可设 `FORMA_NODE_PERMISSION=1` 启用可选的 Node 24 权限标志；无论哪种模式，
  子进程边界与路径检查都是强制项。

## 许可证扫描

**许可证扫描是启发式的工程信号，不是法律意见。** GPL/LGPL/AGPL、未知及相互冲突的
许可证证据始终保持"待评审"或"阻断"状态：它们**不会**被自动放行，没有独立构造的
`LicenseReviewRecord` 就无法通过构建门槛。

## 当前限制

本版本明确不支持的项（非目标）：

- 自动创建或发布 GitHub 仓库
- 真正的（人工在环的）GPL/AGPL 许可证审批流程
- 已安装 Bundle 的自动更新
- 生产部署（仅支持可丢弃的本地 Profile）

契约与验收流程见 `specs/tools.json`、`specs/dto.json`、`provenance/README.md` 和
`FORMAL-ACCEPTANCE.md`。

## 仓库

源码：<https://github.com/BioAIEvolu/aios-plugin-forma>。发行物为固定的 GitHub Release
资产（见下文）；不使用 `npm publish`。

## 本地 CLI

该包包含一个真实的 `aios-plugin-forma` 可执行文件，从本地 tarball 运行：

```powershell
npx --yes --package .\aios-plugin-forma-0.2.1.tgz aios-plugin-forma install `
  --dsh-home <disposable-dsh-home> `
  --profile forma-test `
  --work-root <disposable-work-root> `
  --source-root <fixture-root>\m1\repo-tool-mit
npx --yes --package .\aios-plugin-forma-0.2.1.tgz aios-plugin-forma inspect `
  --dsh-home <disposable-dsh-home> --profile forma-test
npx --yes --package .\aios-plugin-forma-0.2.1.tgz aios-plugin-forma uninstall `
  --dsh-home <disposable-dsh-home> --profile forma-test
```

`--dsh-home`、`--profile`、`--work-root` 和 `--source-root` 始终显式必填：CLI 绝不会
回退到 `%USERPROFILE%\.dsh`。`npm install` 只负责获取该包，`npx` 运行这个二进制，
DSH 在正常的 profile 重启后激活该 Bundle。没有任何生命周期脚本会修改 profile。

### 输出模式

- **默认（人类可读）：** 简洁中文状态行，使用稳定的 `[OK]/[INFO]/[WARN]/[ERROR]`
  标签——无颜色、无表情符号。安装成功会打印下一步和卸载命令；错误会打印稳定的
  `machine_code`、原因和下一步建议，并以文档化退出码结束（2 用法错误、10 缺少
  pnpm、11 URL 策略、12 下载/摘要、13 DSH 失败、14 Profile 被外部修改、15 完整性、
  16 来源目录、17 清理失败）。
- **`--json`：** stdout 只输出一份稳定 JSON（`schema_version: 1`）——字段含
  `command`、`status`、`package`、`version`、`profile`、`dsh_home`、
  `runtime_digest`、`requested_url`/`final_url`、`sha256`、`bytes`、
  `configuration_status`、`runtime_health`、`declared_tool_count`、`pnpm`、
  `next_steps`、`error`。带签名的资产 URL、token 和查询密钥在所有输出中一律脱敏。
- **`--verbose`：** 额外把 DSH/pnpm 原始诊断输出到 stderr。
- **`--plain`：** 装饰字符强制为纯 ASCII。

### install 的实际边界

`install` 完成的是**插件包安装与 Profile 配置写入**（runtimeDigest 与当前 CLI 一致），
它**不会连接正在运行的 DSH**。工具是否激活由你启动/重启 DSH 后的健康检查确认
（`runtime_health: not_checked`）。重复安装是幂等的：`already-installed` 表示版本与
配置均未改变，不会重复调用 DSH。

### pnpm 自动解析

DSH 的插件管理依赖 pnpm。CLI 在每次 install/uninstall 前自动解析：

1. PATH 已有 pnpm → 直接使用；
2. 否则使用当前 Node 附带的 corepack，在**你显式指定的 DSH_HOME** 内创建 Forma 自有
   shim（`<dsh-home>/.forma/shims`，固定 pnpm 12.3.4），只把该目录前置到 DSH 子进程的
   PATH——**不修改系统/用户全局 PATH**，不执行 `corepack enable`；
3. corepack 缓存同样留在 DSH_HOME 内（`.forma/corepack-cache`），卸载时 shim 与缓存
   保留复用，随可丢弃 DSH_HOME 一并删除即可；
4. 两者都不可用才报 `PNPM_REQUIRED`（退出码 10），并说明探测结果与安全安装方法。

解析结果（provider/version/脱敏 shim 路径）写入 `--json` 输出和
`forma-install-record.json`。

## 云端安装

云端安装会下载一个**固定**的 GitHub Release 资产，并在执行任何 DSH 命令之前校验其
SHA-256。只接受固定格式
`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.tgz` 的 URL——
绝不使用 `main`、`latest`、分支归档或任何未固定引用：

```powershell
npx --yes --package .\aios-plugin-forma-0.2.1.tgz aios-plugin-forma install `
  --dsh-home <absolute-disposable-dsh-home> --profile forma-test `
  --work-root <absolute-disposable-work-root> --source-root <absolute-source-root> `
  --package-url https://github.com/BioAIEvolu/aios-plugin-forma/releases/download/v0.2.1/aios-plugin-forma-0.2.1.tgz `
  --sha256 <64-hex-sha256-of-the-release-asset> --max-download-bytes 52428800
```

重定向可能落在 GitHub 的 HTTPS 资产源站。tarball 会以流式写入 `work-root` 下的临时
目录，受限流、计算哈希，并在安装尝试结束后删除。摘要缺失/不匹配或响应超限都会在
任何 DSH 命令执行前返回。安装成功后会持久化 URL、最终 URL、版本、摘要与 DSH 结果到
`forma-install-record.json`。每个版本的固定 tag 与 SHA-256 记录在 GitHub Release notes
中；生成方式见 `RELEASING.md`。

## 验证

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check
npm run preflight
npm pack
```

`npm run check` 会对 `integrity-manifest.json` 中的每个文件重新计算哈希，并拒绝开发
绝对路径；`npm run preflight` 固定 Node/DSH/Cordis 基线。完整的 DSH 验收（在可丢弃
DSH_HOME 中安装、工具调用、候选构建、重启、卸载与篡改拒绝）由 `npm run dsh-forma`
执行——见 `FORMAL-ACCEPTANCE.md`。