# Terminal panel

specrails-desktop ships a full-featured terminal at the bottom of the window. Toggle it with `Cmd+J` (macOS) or `Ctrl+J` (other). It's a real xterm.js with WebGL rendering, shell integration, scrollback search, file drag-and-drop, inline images, and a few quality-of-life touches you won't find in a plain terminal app.

The panel opens your usual shell. On macOS/Linux it honours `$SHELL` (falling back to `/bin/zsh` when `$SHELL` is unset); on Windows it picks PowerShell (`pwsh`, then the built-in `powershell.exe`) and only falls back to `cmd.exe` as a last resort.

> The terminal panel is **on by default**. To turn it off entirely, set `SPECRAILS_TERMINAL_PANEL=false` (server) or build the client with `VITE_FEATURE_TERMINAL_PANEL=false` — both are opt-out (any other value, or unset, keeps the panel on).

```
┌──────────────────────────────────────────────────────────────┐
│   Dashboard content                                         │
│                                                              │
├─────────────────────────────── Cmd+J ────────────────────────┤
│ ▶ specrails-desktop  /Users/you/repos/my-app                │
│ $ git status                                                 │
│ ↳ 28ms · cwd: /Users/you/repos/my-app                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Why use the built-in terminal?

You don't have to. You can keep using iTerm/Windows Terminal/Alacritty/whatever you love. But the built-in panel buys you:

- **Per-prompt timing** — every command taking ≥ 500 ms shows a small live timer in the terminal's top-left corner; once done, the duration sits there as a record.
- **Long-running command notifications** — when a command exceeds 60 seconds and you've context-switched away, you get a native desktop notification.
- **Open this directory** in the right-click menu when a CWD has been observed (Tauri desktop app only).
- **Drag a file from Finder/Explorer** onto the terminal to paste its absolute path (Tauri desktop app only).
- **Live theme switching** — the terminal recolours when you change the app theme without losing scrollback.

### Toolbar shortcuts

The panel header carries three one-click shortcuts:

- **Open AI CLI** (✨ Sparkles) — spins up a fresh session and types the launch command for you. On a single-provider project it launches the project's provider CLI directly (`claude`, `codex`, or `gemini`); on a multi-provider project it opens a small picker so you choose which CLI to start.
- **Open in browser** (🌐 Globe) — opens the URL from the `browserShortcutUrl` setting (default `https://specrails.dev`). Right-click it to jump to the setting and change the URL.
- **Paste quick script** (`</>`) — writes the snippet from the `quickScript` setting (which defaults to a personalised `echo "Wake up, <username> …"` reminder, editable in Settings) into the active session. Right-click it to edit the snippet in Settings. Disabled when there's no active terminal or the snippet is empty.

## Keyboard shortcuts

| Action | macOS | Other |
|--------|-------|-------|
| Toggle panel | `Cmd+J` | `Ctrl+J` |
| Copy selection | `Cmd+C` | `Ctrl+C` |
| Paste (bracketed) | `Cmd+V` | `Ctrl+V` |
| Clear scrollback | `Cmd+K` | `Ctrl+K` |
| Find in scrollback | `Cmd+F` | `Ctrl+F` |
| Zoom font in / out | `Cmd+=` / `Cmd+-` | `Ctrl+=` / `Ctrl+-` |
| Reset font size | `Cmd+0` | `Ctrl+0` |
| Jump to previous prompt | `Cmd+ArrowUp` | `Ctrl+ArrowUp` |
| Jump to next prompt | `Cmd+ArrowDown` | `Ctrl+ArrowDown` |

`Cmd+C` only consumes the keystroke when there's a non-empty selection; otherwise it passes through to the PTY so apps like vim still receive `Ctrl+C`. Inside alt-screen apps with mouse reporting (tmux, htop), hold `Shift` while dragging to bypass mouse-mode and use native xterm selection.

## Right-click menu

Right-click anywhere in the active terminal:

- Copy / Paste / Select All / Clear / Search… / Save scrollback to file…
- **Open `<cwd>`** — when shell integration has reported a CWD via OSC 1337 (Tauri desktop app only). In a plain browser context this item never appears.

Menu position flips when near the bottom-right corner of the viewport.

## Shell integration

Shell integration is **on by default** (toggle in Settings → Terminal panel). The app auto-injects a small shim per shell that emits OSC 133 prompt marks plus OSC 1337 `CurrentDir=…`. The shim runs only in the app's spawned shell — your normal terminal apps elsewhere are untouched.

Per shell:

| Shell | Mechanism |
|-------|-----------|
| zsh | `ZDOTDIR=<shim dir>`; the shim's `.zshrc` sources `~/.zshrc` first |
| bash | `--rcfile <shim path>`; the shim sources `~/.bashrc` first |
| fish | `fish -C "source '<bundled shim>'"` (`--init-command`); runs after `config.fish` / `conf.d`, so your real fish config is preserved |
| PowerShell | `-NoLogo -NoExit -File <shim.ps1>`; the shim dot-sources the original `$PROFILE` |

Each shim sets `SPECRAILS_SHELL_INTEGRATION_LOADED=1` as a sentinel.

If shell integration doesn't bootstrap — for example your `~/.zshrc` runs `exec zsh` (which throws away our `ZDOTDIR`) or a similarly aggressive customisation — there's no error message. The panel detects the missing prompt marks silently; the gutter, per-prompt timing badge, and long-running notifications simply won't appear. If that happens, disable shell integration in Settings; the rest of the panel keeps working.

## Drag and drop

Inside the Tauri desktop app, drop one or more files from Finder/Explorer onto the terminal viewport to paste their absolute paths into the active session. Paths are shell-quoted for your host platform:

- macOS / Linux — POSIX single-quote
- Windows — PowerShell single-quote (the panel's default Windows shell is PowerShell, where single-quoted strings are literal, so this is injection-safe)

In a plain browser context this is a silent no-op — the browser doesn't expose `File.path`.

## Inline images

The panel decodes Sixel and iTerm2 inline-image protocols via `@xterm/addon-image`. Try `imgcat foo.png` or any tool that emits Sixel.

Disable in Settings → Terminal panel → Image rendering if you hit memory pressure on heavy image streams. The per-frame cap is 8 megapixels.

## Settings

Two layers:

- **App-wide defaults** — Desktop Settings (gear icon on the sidebar) → Terminal panel.
- **Per-project overrides** — Project Settings (gear in the project navbar) → Terminal panel.

Project wins per-field; absent fields fall back to app-wide defaults.

Hot-reload semantics:

| Setting | Hot-reload | Notes |
|---------|------------|-------|
| Font family / size | Live | Existing sessions reconfigure immediately |
| Copy on select | Live | |
| Long-running threshold | Live | |
| Notify on completion | Live | |
| Browser shortcut URL | Live | The Open-in-browser toolbar button uses the new value next click |
| Quick script | Live | The Paste-quick-script toolbar button uses the new value next click |
| Render mode (auto / canvas / webgl) | Next session | Live sessions keep their boot-time config |
| Shell integration | Next session | |
| Image rendering | Next session | |

Render mode `auto` picks WebGL when the WebView exposes WebGL2; on `webglcontextlost` the panel transparently reverts to xterm's default renderer.

## Limits and edge cases

- **Sessions per project** — hard cap of 10.
- **Closing a project** — kills all its sessions (SIGTERM, then SIGKILL after a short grace).
- **Window close / quit** — graceful: SIGTERM, 2 s grace, SIGKILL.
- **Cmd+J inside an open Dialog** — ignored. The panel won't toggle on top of a modal.
- **Failed spawn** — if a new session dies within ~1.5 s of opening (for example the host is out of file descriptors), the panel surfaces a concrete reason (e.g. "out of file descriptors") instead of leaving a blank pane.

## Diagnostics

If something looks broken:

1. Open Settings → Terminal panel and confirm shell integration is enabled.
2. Check that `printenv SPECRAILS_SHELL_INTEGRATION_LOADED` outputs `1` inside a freshly opened terminal.
3. Open a session, then `printf '\x1b]133;A\x07'` manually and watch the gutter — a marker should appear.
4. As a last resort, disable shell integration in Settings and re-enable; new sessions receive a fresh shim.

For deeper inspection of how the panel resolves PATH at startup (relevant for Volta/nvm/asdf shims), call `GET /api/setup-prerequisites?diagnostic=1` from the app and check the `pathSegments` / `pathSources` in the response. The install-instructions modal has a **Copy diagnostics** button that does this for you.

## Where to go next

- [Customising the app](customizing.md) — terminal settings, themes.
- [Getting started](getting-started.md) — registering a project.
- [Codex](codex.md) / [Gemini](gemini.md) — setting up the CLI behind the **Open AI CLI** button on a Codex or Gemini project.
