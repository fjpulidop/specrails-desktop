## Why

Each Windows release compressed two ~600 MB installers (WiX MSI and NSIS)
sequentially, both embedding the ~150 MB WebView2 offline installer. On the
windows-11-arm runner that was ~19 min of a 47 min critical path, plus a
second install/uninstall smoke and a second FTP upload per architecture.

## What Changes

- Windows ships only the NSIS `-setup.exe` (x64 and ARM64). **BREAKING** for
  anyone deploying the `.msi` (enterprise/GPO): they switch to the NSIS
  installer, which supports silent installs (`/S`).
- The updater manifest drops `windows-<arch>-msi` entries. Existing MSI
  installs fall back to `windows-<arch>` (NSIS) and Tauri's NSIS installer
  detects and uninstalls the WiX installation before installing.
- WebView2 is provisioned with the embedded bootstrapper (~2 MB) instead of
  the offline installer; it downloads the runtime only where it is missing.
- The first NSIS-only cutover retires legacy `.msi` files from `latest/`.

## Impact

- Release workflow, installer smoke script, updater manifest builder,
  `src-tauri/tauri.conf.json` and a new `tauri.windows.conf.json`.
- Docs: Windows install/update/uninstall guidance and parity audit.
