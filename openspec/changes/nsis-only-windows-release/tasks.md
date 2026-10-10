## 1. Release pipeline

- [x] 1.1 Restrict Windows bundle targets to NSIS (`src-tauri/tauri.windows.conf.json`)
- [x] 1.2 Switch WebView2 provisioning to `embedBootstrapper`
- [x] 1.3 Remove MSI from Windows artifacts, rename, upload and latest/ retention
- [x] 1.4 Smoke only the NSIS package and fail on an unexpected MSI bundle
- [x] 1.5 Drop `windows-<arch>-msi` updater entries; keep `windows-<arch>` → NSIS

## 2. Documentation

- [x] 2.1 Update Windows install, update and uninstall guidance
- [x] 2.2 Update the Windows parity audit and CI/CD overview

## 3. Verification

- [x] 3.1 Script regression tests (`npm run test:scripts`)
- [ ] 3.2 Manual: update an MSI-installed 2.62.x through the in-app updater and confirm a single NSIS installation remains
