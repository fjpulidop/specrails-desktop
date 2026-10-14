## Why

Desktop installers reach users from two places: GitHub Releases (Tauri updater, every release since
1.x) and an FTP mirror on Hostinger (`specrails.dev/downloads/specrails-desktop/{latest,v<version>}/`)
that only feeds the website's download buttons. Release 2.63.1 published to GitHub but the Hostinger
deploy failed twice with `ECONNRESET (data socket)` in FTPS passive mode, leaving the website on
2.63.0. The mirror duplicates ~1.1 GB per release, needs manual quota cleanup, a hand-maintained
`.htaccess`, FTP secrets and a dedicated recovery workflow, and its download counts are invisible.

## What Changes

- **BREAKING (download URLs)**: GitHub Releases becomes the only download channel. The release job no
  longer uploads installers or `manifest.json` to Hostinger; `latest/` and `v<version>/` stop receiving
  new releases. specrails-web reads the latest release from the GitHub API and links GitHub assets.
- `manifest.json` keeps its schema but is published as a GitHub Release asset with GitHub asset URLs.
- The stable-channel downgrade check reads `releases/latest/download/manifest.json` from GitHub.
- Removed: the five FTP deploy/cutover steps, `recover-desktop-channel.yml` and its script/test.
- The Tauri updater (`releases/latest/download/latest.json`) is unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `desktop-release-channel`: stable and versioned downloads move from specrails.dev folders to GitHub
  Releases; manifest location and upload ordering follow.

## Impact

- `.github/workflows/desktop-release.yml`, `scripts/release-policy.mjs`; removes
  `.github/workflows/recover-desktop-channel.yml`, `scripts/recover-desktop-channel{,.test}.mjs`.
- Docs: getting-started, platform guides. specrails-web needs its paired change (GitHub API manifest,
  redirect of old `/downloads/specrails-desktop/*` URLs).
- Ordering: archive after `nsis-only-windows-release`, whose delta still targets the Hostinger
  wording of two requirements this change removes.
- `HOSTINGER_*` secrets in this repo become unused and can be deleted.
