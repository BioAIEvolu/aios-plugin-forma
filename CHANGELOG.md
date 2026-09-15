# Changelog

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
