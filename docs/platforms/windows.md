# Specrails on Windows

> The installed app, its Start Menu entry, and its window title all read **Specrails** — that is the packaged product name.

## Supported configurations

- **Windows 10** (1809 or newer) and **Windows 11**.
- Both **x64** and **ARM64** are first-class targets — each release publishes native installers for both architectures.
- The terminal panel uses ConPTY, which requires **Windows 10 1809+** (always available on Windows 11).

## Installation

Installers are published on every release under:

> 📥 `https://specrails.dev/downloads/specrails-desktop/latest/`

Pick the pair that matches your CPU architecture:

| Architecture | NSIS installer (recommended) | MSI installer (enterprise/group-policy) |
| --- | --- | --- |
| x64 | `specrails-desktop-<version>-x64-setup.exe` | `specrails-desktop-<version>-x64.msi` |
| ARM64 | `specrails-desktop-<version>-arm64-setup.exe` | `specrails-desktop-<version>-arm64.msi` |

If you are unsure which to use, the NSIS `-setup.exe` is the right choice for individual installs; the MSI exists for enterprise deployment. Versioned copies live at `downloads/specrails-desktop/v<version>/` for archival and deep-linking.

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

The **provider CLIs** — **Claude Code**, **Codex**, **Gemini**, and **Kimi
Code** — are **never bundled**. All four are probed through the system `PATH`
with `where.exe`; install at least one. Kimi 0.27+ requires Git for
Windows/Git Bash and the npm distribution requires Node 22.19+, both
user-managed. See [Kimi](../kimi.md), [Codex](../codex.md), and
[Gemini](../gemini.md).

## Updates

The desktop app self-updates via the Tauri updater plugin. It checks a GitHub Releases `latest.json` endpoint and, on Windows, applies updates with `installMode: "passive"` — the update runs with a minimal progress UI and the app relaunches into the new version.

Note that updates are delivered as the **MSI** (verified by an embedded **minisign** signature the updater checks before applying), not the NSIS `-setup.exe` used for first install. Because the installers are not Authenticode-signed, an applied update may still surface the same SmartScreen prompt; click **More info → Run anyway** as during the first install.

## Setup wizard

When you add a project, the setup wizard runs `npx specrails-core@^4.12.0 init --from-config` under the hood (the full spawn is `npx --yes --prefer-online specrails-core@^4.12.0 init --yes --from-config <tempPath>`, with the app writing a temporary `install-config.yaml`). The wizard has three steps — **Configure / Install / Done**.

There are two distinct version floors to be aware of:

- The app **installs** `specrails-core@^4.12.0` — the major-pinned range it ships (4.12.0 is the release that adds the Kimi provider target). The exact package spec is the `CORE_PACKAGE_SPEC` constant in `server/core-package.ts`, so it stays verifiable in one place. You need internet access at install time so `npx` can resolve it.
- The minimum it will **accept** at runtime is **specrails-core ≥ 4.1.0** — the Node-native installer floor (`MIN_NODE_NATIVE_CORE_VERSION`). Anything below that is a legacy bash/python3 installer and cannot run on Windows without WSL.

You can point the app at a local or linked build with the `SPECRAILS_CORE_BIN` environment variable (it overrides the `npx` spec above).

Reserved paths (`.specrails/profiles/**`, `.claude/agents/custom-*.md`) are preserved across re-runs per the contract documented in [specrails-core's README](https://github.com/fjpulidop/specrails-core#reserved-paths).

## Uninstall

- NSIS: use the **Start Menu → Specrails → Uninstall** entry, or *Settings → Apps*.
- MSI: use *Settings → Apps* or `msiexec /x <msi-path>`.

## Known limitations

- **Terminal panel shell**: the bottom terminal panel auto-prefers **PowerShell 7 (`pwsh.exe`)** when it is on your `PATH`, then falls back to Windows PowerShell (`powershell.exe`), and finally `COMSPEC`/`cmd.exe`. Set the `SHELL` environment variable to override the platform default with any shell you prefer. Per-session shell selection is not yet exposed in the UI.
- **Port 4200** must be free on launch. The app binds `127.0.0.1:4200` for its API + WebSocket. If another process holds it, the app shows a native **Specrails — Port Conflict** dialog and exits. When you need to investigate, two files under `%USERPROFILE%\.specrails\` help: `desktop.log` (the embedded server's log output) and `manager.pid` (the running server's process ID).
- **Custom window chrome**: the app uses a frameless window with a custom titlebar; the min/max/close controls are rendered by the app.
- **Code signing**: Windows builds are unsigned in v1 (see SmartScreen above). Authenticode signing is deferred to a later release.

## See also

- [macOS platform guide](./macos.md) — the equivalent guide for Apple Silicon.
- [Getting started](../getting-started.md) — first run, adding a project, the dashboard tour.
- [Codex provider setup](../codex.md), [Gemini provider setup](../gemini.md), and [Kimi provider setup](../kimi.md) — installing and configuring the provider CLIs.
- [CLI reference](../cli.md) — driving Specrails from the command line.
