# Changelog

## 0.2.0 - 2026-09-16

- Reworked CLI user messaging: the default output is now concise, actionable
  Chinese text with stable `[OK]/[INFO]/[WARN]/[ERROR]` labels (no ANSI
  colours, no emoji); `--json` emits a single stable JSON document
  (`schema_version: 1`) for scripts, `--verbose` routes raw DSH/pnpm
  diagnostics to stderr, and `--plain` forces ASCII decoration.
- Added automatic pnpm resolution: PATH pnpm is used directly; otherwise a
  Forma-owned corepack shim (pinned pnpm 12.3.4) is created inside the
  caller-specified DSH_HOME and prepended only to the DSH child-process
  PATH — no global PATH changes, no `corepack enable`. Resolution is recorded
  in the JSON output and `forma-install-record.json`; both pnpm and corepack
  missing yields `PNPM_REQUIRED` (exit 10) with probe results.
- Honest verification scope: install reports package+profile configuration
  only (`configuration_status`, `runtime_health: not_checked`,
  `declared_tool_count`) and never claims a running runtime; inspect reports
  `matched|mismatched|absent` configuration and an explicitly unchecked
  runtime state; uninstall only claims temp-directory cleanup for leftovers
  it actually removed.
- Install distinguishes `installed` / `updated` / `already-installed`
  (idempotent repeat installs skip DSH); inspect reports explicit
  `installed` / `not-installed` states without mutating the profile;
  uninstall reports `already-uninstalled` with exit code 0 and fails loudly
  with residue paths when a bundle or profile config cannot be restored.
- Internal errors map to stable machine codes with actionable hints and
  documented exit codes (2/10/11/12/13/14/15/16/17); signed GitHub asset
  URLs, tokens and query secrets are redacted from all output.
- Guarded against external profile modification during install
  (`PROFILE_CHANGED`) and against temporary-download cleanup failures
  (`CLEANUP_FAILED`).
- Declared tool counts are read from the installed `specs/tools.json`, never
  hard-coded.

## 0.1.1 - 2026-09-15

- Public release for BioAIEvolu/aios-plugin-forma with the verified cloud
  installer (HTTPS GitHub Release asset download + SHA-256 verification before
  DSH invocation, bounded streaming, temp-directory cleanup and install record).
- Added bilingual README (English + 简体中文) with a language switcher.
- Pinned `repository`/`homepage`/`bugs` to the public GitHub repository.
- Enforced LF line endings via `.gitattributes` so Windows clones keep the
  runtime integrity manifest valid.

## 0.1.0 - 2026-09-12

- First formal local repository export of the accepted Forma DSH bundle.
- Embedded the required Forma Core libraries and repo-worker runtime.
- Added reproducible lockfile, integrity manifest, acceptance evidence and local
  Git repository metadata.
- Removed historical evidence and test probes from the publication set; the
  package now ships only the embedded Core, repo Worker runtime and CLI.
- Added gated independent candidate install/call/restart/uninstall validation,
  explicit internal-pack versus export stages, and the local CLI binary.
- Added HTTPS GitHub Release asset installation with bounded streaming download,
  SHA-256 verification before DSH invocation, cleanup, and InstallRecord output.
