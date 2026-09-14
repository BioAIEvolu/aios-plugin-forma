# Releasing aios-plugin-forma

This repository is prepared for publication but is **not** published
automatically. The steps below are manual on purpose.

## 1. Replace the owner placeholder

`package.json` currently uses the placeholder owner `YOUR-GITHUB-USERNAME` in
`repository.url`, `homepage` and `bugs.url`. Replace it with the real GitHub
owner in all three fields.

## 2. Regenerate integrity data

Changing `package.json` changes its hash, so regenerate before packing:

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

## 3. Pack and hash

```powershell
npm pack
```

Compute the release asset digest, for example:

```powershell
(Get-FileHash .\aios-plugin-forma-0.1.0.tgz -Algorithm SHA256).Hash.ToLower()
```

Record this 64-hex value: it is the `--sha256` users must pass to the cloud
installer, and it belongs in the GitHub Release notes.

## 4. Manual GitHub steps (not automated)

1. Create the GitHub repository `aios-plugin-forma` under the real owner.
2. Add the remote and push the `main` branch.
3. Tag the release commit as `v0.1.0` and push the tag.
4. Create a GitHub Release from the tag, attach
   `aios-plugin-forma-0.1.0.tgz`, and paste the SHA-256 from step 3 into the
   release notes next to the pinned download URL:
   `https://github.com/<owner>/aios-plugin-forma/releases/download/v0.1.0/aios-plugin-forma-0.1.0.tgz`

Do not run `npm publish`; distribution is via the pinned GitHub Release asset
only.
