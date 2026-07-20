# Specrails on macOS

## Supported configurations

- **macOS on Apple Silicon (arm64)** — the only architecture the shipped desktop build targets. The official `.dmg` is built on Apple-Silicon CI and named `specrails-desktop-<version>-aarch64.dmg`.
- Intel Macs are supported only via Rosetta / forward-compat. There is no native x86_64 macOS build today.

## Installation

Signed, notarized builds are published on every release under:

> 📥 `https://specrails.dev/downloads/specrails-desktop/latest/`

- `specrails-desktop-<version>-aarch64.dmg` — the Apple Silicon installer.

Versioned copies live at `downloads/specrails-desktop/v<version>/` for archival and deep-linking. A machine-readable `manifest.json` in `latest/` describes the current release (version, sha256, size) so you can verify a download:

```bash
shasum -a 256 specrails-desktop-<version>-aarch64.dmg
```

Compare the output against `platforms["darwin-arm64"].sha256` in `https://specrails.dev/downloads/specrails-desktop/latest/manifest.json`.

To install: open the `.dmg` and drag **Specrails** into `Applications/`.

## Gatekeeper / first launch

Official installers from the release pipeline are **code-signed and notarized**, so they open cleanly — double-click to launch, no extra steps.

**Local or self-built `.app` bundles are unsigned.** Gatekeeper will warn that the app is from an unidentified developer. To run an unsigned local build:

- Right-click the app in `Applications/` → **Open** → confirm **Open** in the dialog, or
- Clear the quarantine attribute from a terminal:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Specrails.app"
  ```

You only need this once per build. It does not apply to the notarized installers above.

## Prerequisites

When you add a project, the app checks for the tools it needs and surfaces them in a **prerequisites panel** (in the `Add Project` dialog and the setup wizard). It checks:

- **Bundled tools** — `node`, `npm`, `npx`, `git`.
- **Provider CLIs** — **Claude Code**, **Codex**, **Gemini CLI**, and **Kimi
  Code**. All four are probed via the system `PATH` and never bundled. At
  least one must be installed and working before Add Project is enabled.

You don't need all four providers. Install whichever you prefer:

| Provider | Install | Minimum CLI | Auth |
|---|---|---|---|
| **Claude Code** | from [claude.com/download](https://claude.com/download) | none pinned | `claude login` |
| **Codex** | `brew install codex` | `0.128.0` | `codex login` |
| **Gemini CLI** | `npm i -g @google/gemini-cli` | `0.11.0` | set `GEMINI_API_KEY` (a paid key from Google AI Studio) |
| **Kimi Code** | official installer or `@moonshot-ai/kimi-code` | `0.27.0` | `kimi login` |

After installing a provider CLI, quit and relaunch Specrails so the new `PATH`
is picked up. See [Kimi](../kimi.md), [Codex](../codex.md), or
[Gemini](../gemini.md).

When everything is in order, the panel collapses to **All required tools
detected**. Detailed rows include each installed Claude/Codex/Gemini/Kimi CLI
only when something is missing, too old, or broken.

## PATH resolution

GUI apps on macOS inherit a minimal `PATH` from launchd when launched from Finder, Dock, or Spotlight. On Apple Silicon this typically omits `/opt/homebrew/bin` and any tool-version-manager shims. The app resolves this differently depending on whether it is running as the shipped desktop app or as a plain server.

### Desktop app (the default for `.dmg` users)

The shipped desktop app bundles its own Node and Git runtimes. When **both** the bundled `node` and `git` bin directories are present, the Tauri host sets `SPECRAILS_IS_DESKTOP=1` and `SPECRAILS_BUNDLED_RUNTIMES_PATH` before spawning the embedded server (`src-tauri/src/lib.rs`). In that mode `resolveStartupPath()` (in `server/path-resolver.ts`):

- Prepends the **bundled** `node` and `git` bin directories to the front of `process.env.PATH`. A system Homebrew or nvm-managed `node`/`git` can never shadow them.
- **Skips** the Homebrew fast-path prepend entirely.
- **Skips** the login-shell merge — `augmentPathFromLoginShell()` is a no-op so it cannot reorder system tools ahead of the bundled ones (`loginShellStatus: "skipped"`).

If a build ships **without** the bundled runtimes — or has only a partial bundle (just one of the two directories present, or a botched extraction) — the desktop app does **not** dead-end: it falls through to the same system discovery described below, so a system-installed `node`/`git` still satisfies the requirement.

### Server / non-bundled fallback

When the app runs without an active bundle (a runtimes-less build, or `npm run dev:server`), the app reconstructs `PATH` in two steps:

1. **Fast path (sync)** — `resolveStartupPath()` prepends any missing well-known package-manager directories to `process.env.PATH`:
   - `/opt/homebrew/bin`, `/opt/homebrew/sbin` (Apple Silicon Homebrew prefix)
   - `/usr/local/bin`, `/usr/local/sbin` (Intel/Rosetta forward-compat and `.pkg` installer destination)

   Existing entries keep their original order; the fast path only fills gaps.

2. **Login-shell merge (async)** — right after the HTTP server starts listening, `augmentPathFromLoginShell()` spawns `$SHELL -l -i` once (1500 ms timeout) and merges whatever `PATH` that login + interactive shell exposes. This recovers the segments that Volta, nvm, fnm, asdf, etc. add only inside your interactive shell — whatever your `$SHELL` produces, no specific rc file is assumed. On timeout or non-zero exit, the fast-path `PATH` stays in effect and a single warning is logged.

The resolved `PATH` is stored on `process.env.PATH`, so every downstream spawn inherits it (`QueueManager` → provider CLI, `SetupManager` → `npx specrails-core`, `terminalManager` PTYs, etc.).

## Broken-symlink detection

If `which node` succeeds but `node --version` fails (typical with a stale `/usr/local/bin/node` symlink left by an old installer pointing at a deleted `Cellar` target), the prerequisites response sets:

- `installed: true`
- `executable: false`
- `meetsMinimum: false`
- `installHint`: `node found at <path> but failed to execute — possibly a broken symlink or a stale install. Reinstall node or remove the stale link at <path>.`

This points you at the actual fix (remove the stale link) instead of sending you in circles reinstalling Node. A separate state — installed, executable, but **below** the required version — reads as `<version> found — needs <minVersion>+`.

## Diagnostic endpoint

`GET /api/setup-prerequisites?diagnostic=1` returns the standard payload plus a `diagnostic` block. The example below is a **non-desktop / server run** (e.g. `npm run dev:server`), where `PATH` is reconstructed via the fast path + inherited entries:

```jsonc
{
  "diagnostic": {
    "pathSegments": ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin"],
    "pathSources": ["fast-path", "fast-path", "fast-path", "fast-path", "inherited", "inherited"],
    "loginShellStatus": "ok",       // "ok" | "skipped" | "timeout" | "error"
    "whichResults": {               // also includes provider CLIs (and "uv" when applicable)
      "node": "/opt/homebrew/bin/node",
      "npm": "/opt/homebrew/bin/npm",
      "npx": "/opt/homebrew/bin/npx",
      "git": "/usr/bin/git",
      "claude": "/opt/homebrew/bin/claude",
      "codex": null,
      "gemini": null,
      "kimi": null
    },
    "nodeEnv": "production",
    "platform": "darwin"
  }
}
```

In the **shipped desktop app** the first segments come from the bundled runtimes instead, so the leading `pathSources` entries read `"bundled"` and `loginShellStatus` is `"skipped"`:

```jsonc
"pathSegments": ["/Applications/Specrails.app/.../runtimes/node/bin", "/Applications/Specrails.app/.../runtimes/git/bin", "..."],
"pathSources": ["bundled", "bundled", "..."],
"loginShellStatus": "skipped"
```

`whichResults` is keyed by command name for **every** prerequisite the panel checks, so it includes `claude`/`codex`/`gemini`/`kimi` (and `uv` when probed) on top of the four bundled tools. A `null` value means that command was not found on `PATH` — in the example above, only Claude Code is installed.

The install-instructions modal exposes a **Copy diagnostics** button that fetches this endpoint and copies the JSON to the clipboard for bug reports. The base endpoint (no `?diagnostic=1`) omits the `diagnostic` field, keeping the regular UI poll small.

## Verifying manually

After installing or reinstalling Node (or a provider CLI):

1. Quit Specrails completely (**Cmd-Q**, not just close the window).
2. Relaunch from `Applications/`.
3. Open the `Add Project` dialog.
4. The panel should collapse to **All required tools detected**. If something is still flagged, the per-tool list expands — find the red row, click **More info → Copy diagnostics**, and inspect its `whichResults` entry and `pathSegments` to see whether the resolver found the binary you expect.

## Known limitations

- **Provider requirement**: at least one provider CLI — Claude Code, Codex,
  Gemini, or Kimi — must be installed and on `PATH`; otherwise Add Project
  stays disabled.
- **Port 4200** must be free on launch. The app binds `127.0.0.1:4200` for its API + WebSocket; if another process holds the port, the server cannot start.
- **Terminal panel**: the bottom terminal panel spawns `$SHELL -l -i`, so your `.zshrc` / `.bashrc` loads as it would in a normal login shell. Per-session shell selection is not yet exposed in the UI — set `SHELL` to override the default.
