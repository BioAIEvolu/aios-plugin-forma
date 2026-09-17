# aios-plugin-forma

[English](README.md) | [简体中文](README.zh-CN.md)

`aios-plugin-forma` is the AIOS self-building DSH plugin (Bundle). Given a
local source project, it scans the source, identifies reusable capabilities,
generates candidate plugins from a reviewed selection, and exports a candidate
plugin repository — all through versioned `forma_*` DTO tools. All source
inspection and candidate work is delegated to a Supervisor-owned child Worker;
the Host never imports or evaluates source-project code.

This repository embeds the required Forma Core under `core/`; it does not
depend on a workspace core-root environment variable, AIOS, or the development
`forma/` tree. Only `workRoot` and caller-selected source roots enter through
the DSH Profile. The worker reads only configured source roots and writes only
the managed work root.

## Security and safety model

- **The Worker is a process boundary, not an OS-level malicious-code sandbox.**
  A Node permission flag and the child-process boundary are defense in depth.
  Do not point Forma at source code you would not run yourself.
- A `source-root` is a read boundary, not a source-code approval. Direct-source
  candidate generation additionally requires an explicit reviewed-source-root
  record; the bundled CLI writes no such approval, so an ordinary user-selected
  source remains scanned but blocked from direct-source generation.
- The default route is proposal-only: candidate generation creates a tarball
  and reports, but never installs the generated plugin into the running
  Profile.
- Set `FORMA_NODE_PERMISSION=1` for the optional Node 24 permission flags
  during local runs; the child-process boundary and path checks remain
  mandatory in both modes.

## License scanning

**License scanning is a heuristic engineering signal, not legal advice.**
GPL/LGPL/AGPL, unknown and conflicting license evidence remains
review-required or blocked: it is **not** approved automatically and cannot
pass the build gate without an independently constructed `LicenseReviewRecord`.

## Current limitations

Not yet supported (explicit non-goals for this release):

- Automatic GitHub repository creation or publishing
- A real (human-in-the-loop) GPL/AGPL license approval workflow
- Automatic updates of installed bundles
- Production deployment (disposable local Profiles only)

See `specs/tools.json`, `specs/dto.json`, `provenance/README.md`, and
`FORMAL-ACCEPTANCE.md` for the contract and acceptance procedure.

## Repository

Source: <https://github.com/BioAIEvolu/aios-plugin-forma>. Releases are
pinned GitHub Release assets (see below); `npm publish` is not used.

## Local CLI

The package contains a real `aios-plugin-forma` binary. It is exercised from a
local tarball:

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

`--dsh-home`, `--profile`, `--work-root` and `--source-root` are always
explicit and required: the CLI never falls back to `%USERPROFILE%\.dsh`.
`npm install` only obtains the package, `npx` runs this binary, and DSH
activates the bundle after its normal profile restart. No lifecycle script
modifies a profile.

### Output modes

- **Default (human):** concise Chinese status lines with stable
  `[OK]/[INFO]/[WARN]/[ERROR]` labels — no colours, no emoji. Errors print a
  stable `machine_code`, the cause and a next-step hint, and exit with a
  documented code (2 usage, 10 pnpm missing, 11 URL policy, 12
  download/digest, 13 DSH failure, 14 external profile change, 15 integrity,
  16 source root, 17 cleanup).
- **`--json`:** one stable JSON document on stdout (`schema_version: 1`) with
  `command`, `status`, `package`, `version`, `profile`, `dsh_home`,
  `runtime_digest`, `requested_url`/`final_url`, `sha256`, `bytes`,
  `configuration_status`, `runtime_health`, `declared_tool_count`, `pnpm`,
  `next_steps`, `error`. Signed asset URLs, tokens and query secrets are
  redacted from all output.
- **`--verbose`:** raw DSH/pnpm diagnostics on stderr.
- **`--plain`:** forces ASCII decoration.

### What install actually verifies

`install` completes **package installation and profile configuration** (the
written runtimeDigest matches the current CLI). It never connects to a running
DSH host: tool activation is confirmed by a health check after you start or
restart DSH (`runtime_health: not_checked`). Repeat installs are idempotent —
`already-installed` means version and configuration are unchanged and DSH is
not invoked again.

### Automatic pnpm resolution

DSH plugin management needs pnpm. Before every install/uninstall the CLI
resolves it without touching the global PATH:

1. pnpm already on PATH → used directly;
2. otherwise the Node-bundled corepack backs a Forma-owned shim inside the
   **caller-specified DSH_HOME** (`<dsh-home>/.forma/shims`, pinned pnpm
   12.3.4), prepended only to the DSH child-process PATH — no
   `corepack enable`, no system/user PATH changes;
3. the corepack cache also stays inside DSH_HOME (`.forma/corepack-cache`);
   shims and cache are retained for reuse and disappear with the disposable
   DSH_HOME;
4. only when both are unavailable does the CLI fail with `PNPM_REQUIRED`
   (exit 10), reporting the probe results and safe installation options.

The resolution (provider/version/redacted shim path) is recorded in the
`--json` output and in `forma-install-record.json`.

### Output modes

- **Default (human):** concise Chinese status lines with stable
  `[OK]/[INFO]/[WARN]/[ERROR]` labels — no ANSI colours, no emoji. Successful
  installs print next steps and the uninstall command; errors print a stable
  `machine_code`, the cause and the next action, and exit with a documented
  code (2 usage, 10 pnpm missing, 11 URL policy, 12 download/digest,
  13 DSH failure, 14 profile changed externally, 15 integrity, 16 source
  root, 17 cleanup).
- **`--json`:** exactly one stable JSON document (`schema_version: 1`) on
  stdout — fields include `command`, `status`, `package`, `version`,
  `profile`, `dsh_home`, `runtime_digest`, `requested_url`/`final_url`,
  `sha256`, `bytes`, `next_steps` and `error`. Signed asset URLs, tokens and
  query secrets are redacted everywhere.
- **`--verbose`:** additionally streams raw DSH/pnpm diagnostics to stderr.
- **`--plain`:** forces ASCII decoration characters.

## Cloud installation

Cloud installation downloads a **pinned** GitHub Release asset and verifies
its SHA-256 before any DSH command runs. Only fixed
`https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.tgz` URLs
are accepted — never `main`, `latest`, branch archives or any unpinned
reference:

```powershell
npx --yes --package .\aios-plugin-forma-0.2.1.tgz aios-plugin-forma install `
  --dsh-home <absolute-disposable-dsh-home> --profile forma-test `
  --work-root <absolute-disposable-work-root> --source-root <absolute-source-root> `
  --package-url https://github.com/BioAIEvolu/aios-plugin-forma/releases/download/v0.2.1/aios-plugin-forma-0.2.1.tgz `
  --sha256 <64-hex-sha256-of-the-release-asset> --max-download-bytes 52428800
```

Redirects may end at GitHub's HTTPS asset hosts. The tarball is streamed into
a temporary directory below `work-root`, bounded, hashed, and deleted after
the install attempt. A missing/mismatched digest or oversized response returns
before any DSH command. Successful installs persist URL, final URL, version,
digest and DSH result in `forma-install-record.json`. The concrete tag and
SHA-256 for each release are recorded in the GitHub Release notes; see
`RELEASING.md` for how they are produced.

## Verification

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check
npm run preflight
npm pack
```

`npm run check` re-hashes every file in `integrity-manifest.json` and rejects
absolute development paths; `npm run preflight` pins the Node/DSH/Cordis
baseline. The full DSH acceptance (install, tool calls, candidate build,
restart, uninstall and tamper rejection in a disposable DSH_HOME) is
`npm run dsh-forma` — see `FORMAL-ACCEPTANCE.md`.
