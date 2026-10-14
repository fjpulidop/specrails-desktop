## 1. Release workflow

- [x] 1.1 Point manifest URLs at `releases/download/<tag>/` and upload `manifest.json` with the release assets
- [x] 1.2 Remove the Hostinger versioned deploy and the latest/ snapshot, upload, verify and retire steps
- [x] 1.3 Read the downgrade check's current version from the GitHub latest-release manifest
- [x] 1.4 Remove `recover-desktop-channel.yml` and its script and test

## 2. Documentation

- [x] 2.1 Update getting-started and platform guides to GitHub Releases download and checksum steps
- [x] 2.2 Regenerate the source map

## 3. Verification

- [x] 3.1 `npm run test:scripts` and workflow lint pass
- [ ] 3.2 Next release publishes `manifest.json` on GitHub and specrails-web shows that version
