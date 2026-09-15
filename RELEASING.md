# Releasing aios-plugin-forma

Distribution is via pinned GitHub Release assets only — no `npm publish`.

Repository: <https://github.com/BioAIEvolu/aios-plugin-forma>

## Regenerate integrity data (whenever a shipped file changes)

Changing `package.json` or any file in the runtime manifest changes its hash,
so regenerate before packing:

```powershell
node scripts/generate-integrity.mjs
```

Copy the printed `runtimeDigest` into both `cordis.patch.yml` and
`dsh.bundle.patch` (the `config.runtimeDigest` value), then re-run:

```powershell
npm test
npm run check
npm run preflight
```

## Pack and hash

```powershell
npm pack
```

Compute the release asset digest:

```powershell
(Get-FileHash .\aios-plugin-forma-0.1.1.tgz -Algorithm SHA256).Hash.ToLower()
```

Record this 64-hex value: it is the `--sha256` users must pass to the cloud
installer, and it belongs in the GitHub Release notes.

## Remaining manual step (Release asset)

Tag the release commit and create the GitHub Release manually. For `v0.1.1`:

1. Tag the release commit as `v0.1.1` and push the tag if not already on the
   remote.
2. Create a GitHub Release from the tag, attach
   `aios-plugin-forma-0.1.1.tgz`, and paste the SHA-256 from above into the
   release notes next to the pinned download URL:
   `https://github.com/BioAIEvolu/aios-plugin-forma/releases/download/v0.1.1/aios-plugin-forma-0.1.1.tgz`