# Specrails on Windows

> The installed app, its Start Menu entry, and its window title all read **Specrails** — that is the packaged product name.

## Supported configurations

- **Windows 10 x64** (1809 or newer) and **Windows 11 x64/ARM64**.
- Both **x64** and **ARM64** are first-class targets — each release publishes native installers for both architectures.
- The terminal panel uses ConPTY on supported Windows builds and ships the node-pty WinPTY fallback for older Windows 10 builds.
- The installer embeds the evergreen WebView2 offline installer, so provisioning the app webview does not require a network connection.

## Installation

Installers are published on every release under:

> 📥 `https://specrails.dev/downloads/specrails-desktop/latest/`

Pick the installer that matches your CPU architecture:

| Architecture | Installer |
| --- | --- |
| x64 | `specrails-desktop-<version>-x64-setup.exe` |
| ARM64 | `specrails-desktop-<version>-arm64-setup.exe` |

Windows ships only the NSIS installer. For unattended or managed deployment, run it silently with `/S` (optionally `/D=<install dir>` as the last argument). Releases up to 2.62 also published an `.msi`; see [Updates](#updates) for how those installations migrate. The installer provisions Microsoft Edge WebView2 when it is missing, downloading it through a small embedded bootstrapper (Windows 11 and current Windows 10 already include it). Versioned copies live at `downloads/specrails-desktop/v<version>/` for archival and deep-linking.

A machine-readable `manifest.json` in `latest/` describes the current release (version, sha256, size) per platform, including `windows-x64` and `windows-arm64` entries — consumers can read it to build download links without hardcoding a version.

## SmartScreen warning

The Windows installers are **not code-signed** in v1. Running them triggers Microsoft SmartScreen:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.

To install:

1. Click **More info**
2. Click **Run anyway**

This warning is expected and will persist until Authenticode code signing is added in a later release. The installer and the bundled server binary are built by GitHub Actions from source, and their sha256 hashes are published in `manifest.json` — verify before running if you want higher assurance:

```powershell
Get-FileHash specrails-desktop-<version>-x64-setup.exe -Algorithm SHA256
```

Compare the output against the matching architecture's `sha256` (`platforms["windows-x64"].sha256` or `platforms["windows-arm64"].sha256`) in `https://specrails.dev/downloads/specrails-desktop/latest/manifest.json`.

## What's bundled

The desktop app ships its own **Node** and **Git** runtimes inside the bundle, so you do **not** need to pre-install them:

- `runtimes/node/{node.exe, npm.cmd, npx.cmd}`
- `runtimes/git/cmd/git.exe` (the app probes this path first, then falls back to `runtimes/git/bin/git.exe` — PortableGit ships the real binary at `cmd/git.exe` with a redirector at `bin/git.exe`)

When the bundle is present, the Tauri host sets `SPECRAILS_IS_DESKTOP=1` and `SPECRAILS_BUNDLED_RUNTIMES_PATH`, and the embedded server prepends the bundled `node`/`git` directories to the front of `PATH` so a system install can never shadow them. If a build ships **without** the runtimes (or a partial extraction occurs), the app does not dead-end — it falls back to discovering `node`/`git` on your system `PATH` (probed with Windows `where.exe`) instead of reporting a corrupted bundle.

## Updates

The desktop app self-updates via the Tauri updater plugin. It checks a GitHub Releases `latest.json` endpoint and, on Windows, applies updates with `installMode: "passive"` — the update runs with a minimal progress UI and the app relaunches into the new version.

Updates use the signed NSIS `-setup.exe` for the same architecture. Installations made from an earlier `.msi` receive that NSIS update too: the installer detects the MSI installation and removes it before installing, so a single installation remains (Windows may ask for administrator approval to remove the machine-wide MSI). The signatures are Tauri/minisign integrity signatures, separate from Authenticode signing. An incomplete installer/signature pair blocks publication.

Normal quit and updates request an authenticated graceful shutdown of the owned sidecar first, giving processes and persistent logs time to close before a bounded force-stop fallback.

## Setup wizard

Adding a project assembles the framework from the bundled or newer compatible activated core. The installed app includes the Node-native core and OpenSpec resources, so normal project setup does not require a separate core installation. Core updates preserve the previous active framework if switching the Windows junction fails.

Online fallback uses the range in `server/core-package.ts` (currently `specrails-core@^5.0.0`). Runtime selection and the activated version are shared with the Settings view so a restart cannot silently downgrade a newer working core. `SPECRAILS_CORE_BIN` remains available for a deliberately selected local core executable. Legacy pre-4.1 bash/Python installers are not used for Windows setup.

Reserved paths (`.specrails/profiles/**`, `.claude/agents/custom-*.md`) are preserved across re-runs per the contract documented in [specrails-core's README](https://github.com/fjpulidop/specrails-core#reserved-paths).

## Uninstall

- Use the **Start Menu → Specrails → Uninstall** entry, or *Settings → Apps*.
- An installation from an earlier `.msi` release that has not updated yet: *Settings → Apps* or `msiexec /x <msi-path>`.

## Known limitations

- **Terminal panel shell**: the bottom terminal panel auto-prefers **PowerShell 7 (`pwsh.exe`)** when it is on your `PATH`, then falls back to Windows PowerShell (`powershell.exe`), and finally `COMSPEC`/`cmd.exe`. Unix `SHELL` values inherited from Git Bash are ignored on Windows. Per-session shell selection is not yet exposed in the UI. File drops use the actual session shell; paths that cmd.exe would expand cannot be pasted as if they were literal paths.
- **Port 4200** must be free on launch. The app binds `127.0.0.1:4200` for its API + WebSocket. If another process holds it, the app shows a native **Specrails — Port Conflict** dialog and exits. When you need to investigate, two files under `%USERPROFILE%\.specrails\` help: `desktop.log` (the embedded server's log output) and `manager.pid` (the running server's process ID).
- **Custom window chrome**: the app uses a frameless window with a custom titlebar; the min/max/close controls are rendered by the app.
- **Code signing**: Windows builds are unsigned in v1 (see SmartScreen above). Authenticode signing is deferred to a later release.

## See also

- [macOS platform guide](./macos.md) — the equivalent guide for Apple Silicon.
- [Getting started](../getting-started.md) — first run, adding a project, the dashboard tour.
- [CLI reference](../cli.md) — driving Specrails from the command line.

## Verification

See [Windows parity audit](./windows-parity.md) for coverage, automated release gates and the real-device checks still required before making a compatibility claim. The source checks run on Windows x64 for every change and on ARM64 for pushes to `main` (`windows-parity.yml`, separate from the release-gating CI). Desktop Release installs both NSIS and MSI packages in temporary paths with spaces and exercises the installed server, database, repository browsing, PTY input/output/stop, graceful shutdown and restart.
