# Contributing

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run check`,
`npm run preflight`, and `npm pack` before proposing a change. Run
`FORMA_TEST_SOURCE_DIR=<reviewed-fixture> npm run dsh-forma` for a disposable
DSH acceptance. Regenerate the lockfile, integrity manifest, runtime digest and
acceptance evidence together.

Keep Core self-contained under `core/`; do not add workspace absolute paths,
remote configuration, GitHub automation, or production-profile mutation. Do not
add evidence, probes, test fixtures, lockfiles or temporary tarballs to the npm
publication set. The CLI must always require an explicit DSH_HOME.
