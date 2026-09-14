# Formal acceptance

This public repository does not commit acceptance evidence: DSH validation
reports contain machine-local paths and live only in the local (gitignored)
`evidence/` directory of the checkout that produced them. The last local
acceptance before publication passed on DSH 0.1.3-alpha.2, Cordis 4.0.2,
Include 1.0.7 and Node 24.14.0.

A fresh acceptance run is produced with:

```powershell
$env:FORMA_TEST_SOURCE_DIR = '<fixture-root>\m1\repo-tool-mit'
npm run dsh-forma
```

The run uses a new disposable `.work/dsh-forma-*` DSH_HOME, dynamically scans
the supplied source, builds and validates one selected capability, checks
GPL/unknown blocking, restart, uninstall baseline restoration, PID/cleanup
behavior and tamper rejection for Host/Worker/Core/manifest/provenance/package.
It writes its machine-specific report under `evidence/` and must never fall
back to a user-level DSH home.

Cloud-install unit/integration coverage is in `tests/cloud-download.test.mjs`:
successful bounded SHA-256 verification, digest mismatch, oversized response,
and local HTTP/non-HTTPS rejection. Cloud install does not call DSH until the
download digest passes, and writes `forma-install-record.json` on success.
