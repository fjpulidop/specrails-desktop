## Context

Today's panel (`client/src/features/terminals/context/TerminalsContext.tsx` + `client/src/components/terminal/*` + `server/modules/terminals/runtime/terminal-manager.ts`) renders xterm.js with three addons (`fit`, `web-links`, plus the css). PTY data flows in as binary frames over a dedicated `/ws/terminal/:id` socket; user input flows out as binary; resizes are JSON control frames. Settings are hardcoded constants. There is no link between what the user types and what the panel knows about (no shell integration), and there is no notion of "command" — only a stream of bytes.

The starting xterm version in the repo and the CSS lifecycle (`@xterm/xterm/css/xterm.css` imported once) mean we can layer additional addons without ripping anything out. The hidden-host reparent pattern (`#specrails-terminal-host`) keeps `Terminal` instances alive across React StrictMode double-invokes and project switches; that pattern is load-bearing and stays.

Constraints we cannot break:

- Per-project isolation of state and PTYs (`project-terminal-panel`, `terminal-pty-bridge`).
- Single shared `/ws` socket for project events; the dedicated `/ws/terminal/:id` socket for PTY traffic must not be co-mingled with project events.
- Hub-mode persistence layout: hub-level settings in `~/.specrails/hub.sqlite`, per-project state in `~/.specrails/projects/<slug>/jobs.sqlite`.
- Tauri sidecar packaging — anything we add must travel inside the app bundle (icons, shim scripts, native deps).

Stakeholders are the developers who live inside the panel for hours per day. The success bar is "feels like Ghostty / VSCode terminal, not a webapp xterm".

## Goals / Non-Goals

**Goals:**

- Solve the three observed bugs (drag-drop path injection, tmux-friendly copy/paste, sidebar-resize jitter) with code paths that are testable on Linux/macOS CI.
- Land OSC 133 + OSC 1337 shell integration that auto-injects on next spawn for zsh, bash, fish, and PowerShell, with an opt-out toggle and zero configuration in the happy path.
- Keep the existing terminal UX invariants: panel visibility states, project isolation, focus on Cmd+J, scrollback survival across project switches, no-confirm minimize, kill-with-confirm-on-trash.
- Make every new piece (addons, integration, image rendering) independently disable-able via settings, so a user can degrade to today's experience if any layer misbehaves.
- Persist user customisations once and resolve them deterministically: per-project override → hub default → built-in default.

**Non-Goals:**

- Rewriting the panel using a different terminal engine (no Warp-style block UI, no custom renderer). xterm.js stays.
- Cross-session command history search UI (the per-session command-mark ring is the building block; the search UI is a follow-up).
- Authenticated remote terminals (SSH/serial). Local PTY only.
- Theming gallery / colour pickers. Default theme remains; we add at most a fixed shortlist.
- Split panes inside one session.
- Migrating existing PTY sessions to shell integration on the fly. Shell-integration toggling takes effect on the *next* spawn.

## Decisions

### Decision 1: Auto-inject the shell-integration shim via `--init-file`, not via rc-file edits

**What we'll do.** When `terminal_settings.shellIntegrationEnabled` is true (default), `terminal-manager.ts` resolves the shell, locates the bundled shim (e.g. `server/shell-integration/zsh-shim.zsh`), copies it to a per-session writable path under `~/.specrails/projects/<slug>/terminals/<id>/shim.zsh` (chmod 600, regenerated each spawn so we can revision it without touching the user's filesystem permanently), and prepends the appropriate flag:

| Shell      | How we inject                                                                 |
| ---------- | ----------------------------------------------------------------------------- |
| zsh        | `ZDOTDIR=<dir>` env var pointing at the temp dir; `.zshrc` there sources `~/.zshrc` then loads our shim |
| bash       | `--rcfile <shim>` (interactive); shim sources `~/.bashrc` then defines our hooks |
| fish       | `XDG_CONFIG_HOME=<dir>` with a `fish/conf.d/specrails-shim.fish` that loads after user config |
| PowerShell | `$env:PROFILE` override + `-NoExit -File <shim.ps1>`; shim dot-sources the original `$PROFILE` if present |

**Why over the alternatives:**

- *Editing the user's ~/.zshrc / ~/.bashrc directly* (VSCode's older approach) — touches user-owned files, requires opt-in flow and cleanup-on-uninstall, and is brittle when the user already has another tool injecting (asdf, atuin, starship). We avoid this entirely.
- *Source-from-rc-file installer command* — same drawbacks, plus a worse first-run experience: nothing happens until the user pastes a line and reopens.
- *No shell integration* — eliminates the marquee feature.
- *Inject only for our PTY, leave system shells untouched* — exactly what `--init-file` / `ZDOTDIR` accomplishes. The shim is local to *our* spawned shell, the user's terminal apps elsewhere are untouched.

**Trade-off:** if the user's `~/.zshrc` itself runs `exec zsh`, our `ZDOTDIR` is dropped. Mitigated by a sanity check: after the shim runs, it sets a sentinel env var; if the panel never sees an OSC 133 mark within ~5s of the first prompt, we surface a one-time toast offering "switch to opt-in mode" (manual snippet).

### Decision 2: OSC parsing happens server-side, structured marks pushed as JSON control frames

**What we'll do.** A streaming parser in `terminal-shell-integration.ts` scans every PTY chunk for `\x1b]133;A`, `;B`, `;C`, `;D`, and `\x1b]1337;CurrentDir=…`/`File=…` sequences. The bytes are *not* stripped from the binary stream sent to xterm (the addon-image renderer needs OSC 1337 `File=` intact). The parser additionally synthesises a `{ type: "mark", kind, payload }` JSON message and sends it on the same WebSocket. The client routes binary frames to xterm as today, and JSON frames to a new `commandMarkStore` keyed by sessionId.

**Why over client-side parsing:**

- Server already controls the byte stream end-to-end and knows when the PTY exits (so a dangling `pre-exec` without `post-exec` becomes "killed"). It also persists marks to the per-project DB without an extra round-trip.
- A client-side parser would force xterm to expose a write hook (it does, via `term.parser.registerOscHandler`), but then we'd need a separate persistence call.
- Centralising the parser also means PowerShell support (which uses non-standard CMD/CMD-like sequences) is one well-tested module.

**Trade-off:** parser bugs affect every session. Mitigated by a malformed-sequence-tolerant implementation (regex with bounded lookahead, never blocks the stream) and unit tests that fuzz a corpus of real shell prompt outputs (oh-my-zsh, starship, p10k, plain).

### Decision 3: Render addons load lazily and degrade silently

**What we'll do.** Construct the `Terminal` first; *after* the container is attached, attempt addon loads in this order: WebGL → Unicode 11 → Ligatures → Search → Image. Each is wrapped in try/catch with a soft fallback. WebGL specifically:

```
if (renderMode === 'webgl' || (renderMode === 'auto' && webgl2Available())) {
  try { term.loadAddon(new WebglAddon()); webgl.onContextLoss(() => fallbackToCanvas()) }
  catch { fallbackToCanvas(toast='WebGL init failed') }
}
```

**Why over a "force one renderer" choice:** WebGL2 is widely available but Tauri's WebView on older Windows can be flaky; ligatures degrade silently if the font lacks them; image addon adds ~150KB and not every user wants it (settings toggle). The lazy/conditional pattern keeps every layer optional.

**Trade-off:** five places to maintain. Compensated by a single `loadAddons(term, settings)` helper with a unit test per addon's enable/disable matrix.

### Decision 4: Tauri drag-drop event, not HTML5 DataTransfer

**What we'll do.** In `client/src/lib/tauri-drag-drop.ts`, use `@tauri-apps/api`'s `getCurrentWebview().onDragDropEvent` to receive `{ type: 'drop', paths: string[], position }` events. Hit-test the drop position against the active terminal viewport's bounding rect. If the active session is focused, shell-quote each path for the host platform and call `term.paste(paths.join(' '))`. In a non-Tauri context, the listener registration is a no-op (silent fallback). HTML5 `dragover`/`drop` listeners are still added on the viewport so we can render a visual highlight, but we do not attempt to read `e.dataTransfer.files[].path` (it is not available in browsers).

**Why over HTML5-only:** browser sandboxing forbids access to `File.path`. We would have only the `name`, which is useless. Tauri exposes the absolute filesystem path as part of its native drag-drop event.

**Trade-off:** drag-drop only works in the desktop app, not when running the dev server in a plain browser. Acceptable; we ship the panel primarily inside the desktop app.

### Decision 5: Settings live in the existing key/value `hub_settings` table plus a per-project override key/value table

**What we'll do.** The repo already uses key/value patterns for settings (`hub_settings(key, value)` in `~/.specrails/hub.sqlite`, `queue_state(key, value)` per-project). Adopt the same shape rather than introduce a parallel "discrete-columns" style:

- Hub-level defaults are written under reserved keys in `hub_settings`: `terminal.fontFamily`, `terminal.fontSize`, `terminal.renderMode`, `terminal.copyOnSelect`, `terminal.shellIntegrationEnabled`, `terminal.notifyOnCompletion`, `terminal.imageRendering`, `terminal.longCommandThresholdMs`. Values are stored as strings (numbers/booleans serialised) and parsed in the access layer. Defaults are seeded on the new migration.
- Per-project overrides live in a new key/value table `terminal_settings_override(key, value)` inside each project's `jobs.sqlite`. A row's *presence* means "override this field"; absence means "inherit hub default". Setting a field to `null` over the REST API translates to a row delete (so the inherit-from-hub semantics are unambiguous).
- `resolveTerminalSettings(projectId)` reads both layers and returns a typed `TerminalSettings` object via a per-key COALESCE-by-presence merge in TypeScript (project override wins; hub default fills in).

**Why over discrete columns:** the codebase's existing convention is key/value (`hub_settings`, `queue_state`). Introducing a discrete-column table would diverge from that style, complicate migrations whenever we add a new setting, and make REST PATCH semantics less clean (we'd have to interpret JSON `null` as either "clear" or "don't change", and a partial PATCH would force us to know the schema; with key/value the PATCH is just a set of upserts and a set of deletes).

**Why over one big JSON blob:** stronger validation per field, easier diffs, cleaner audit trail in `hub_settings` rows.

**Trade-off:** values are stored as TEXT and need parsing/serialising. The accessor layer (`server/modules/terminals/runtime/terminal-settings.ts`) owns the codec, with tight unit tests.

### Decision 6: Resize debounce, not throttle, and `transitionend` listener on ancestor sidebars

**What we'll do.** Replace the rAF-only throttle with a trailing 120ms debounce in the `ResizeObserver` callback. Additionally, the viewport listens for `transitionend` events bubbling from ancestor `<aside>` / `[data-sidebar]` elements; on `transitionend` whose target is one of those ancestors, we issue an immediate refit to settle the geometry exactly once. Because xterm's canvas/webgl layer reflows synchronously on each `fit.fit()`, debouncing prevents the mid-transition jitter while the `transitionend` shot guarantees a clean final frame.

**Why over throttle:** throttle keeps emitting refits at a fixed cadence, which is precisely what produces the jitter during a 200ms CSS animation (every frame fires). Debounce-trailing emits *once*, after the geometry has stabilised. The `transitionend` belt-and-braces guards against the case where the sidebar finishes animating without any further ResizeObserver tick (rare but possible if no inner content changes).

**Trade-off:** during the 120ms window, the panel content is at the previous size — text may visibly scale until the trailing refit. Acceptable, and far better than the current jitter.

### Decision 7: One change, one merge — not three sequenced PRs

**What we'll do.** Ship Tier 1 + Tier 2 + Tier 3 as a single OpenSpec change. The user explicitly asked for "todo de golpe". Internally the implementation is already partitioned (Tier 1 = `TerminalsContext` resize debounce + drag-drop + key handler; Tier 2 = addon loading + settings UI; Tier 3 = shell integration server module + DB migrations + prompt gutter), but the artifact and the merge are atomic.

**Why over phased releases:** the cross-cutting infrastructure (settings tables, control-frame protocol, addon loader) is shared across tiers. Splitting would either duplicate scaffolding or block Tier 1 on Tier 3 review. Single change keeps the narrative coherent and the diff reviewable as one feature.

**Trade-off:** the PR is large (~25-30 files). Mitigated by tight commit boundaries within the branch (one tier per commit) and a thorough tasks list that maps 1:1 to those commits.

## Risks / Trade-offs

- **Shell-integration shim conflicts with user's existing tooling (asdf, atuin, starship)** → Mitigation: shim runs the user's `~/.zshrc` *first*, then layers our hooks on top. Our `precmd`/`preexec` hooks are appended via `precmd_functions+=` (zsh) / `PROMPT_COMMAND="…; existing"` (bash) — never overwriting. A sentinel-not-seen toast offers manual fallback.
- **WebGL renderer flakey on older Tauri WebView (Windows)** → `webglcontextlost` handler swaps to canvas + toast; `renderMode='canvas'` setting forces it.
- **Inline image addon increases bundle by ~150KB** → Acceptable; controlled by `image_rendering` setting (default ON, opt-out).
- **OSC parser regex on every PTY chunk** → Bounded by chunk size (PTY default 4-8KB), and the regex is anchored to `\x1b]` start bytes; we benchmark in `terminal-shell-integration.test.ts` and gate at p99 < 0.2ms per chunk.
- **Tauri drag-drop API surface differs between v1 and v2** → We target the version pinned in `src-tauri/Cargo.toml`, and feature-detect at runtime so a future bump won't crash.
- **Per-session shim file leaks if the server crashes mid-session** → Cleanup on next startup: `terminal-manager` scans `~/.specrails/projects/*/terminals/*/shim.*` and removes anything older than 24h with no matching live PTY.
- **Custom-key handler can swallow accessibility shortcuts** → `attachCustomKeyEventHandler` returns `true` (let xterm handle) for everything we don't claim explicitly. We test against screen-reader common keys (Cmd+Opt+arrow on macOS, NVDA chord on Windows) to ensure they pass through.
- **Migration backwards compatibility** → New tables/columns are additive; older builds continue to read the same data without the terminal-settings columns. No data is rewritten.
- **Notifications can be noisy on slow shells** → Threshold is configurable (default 60s) and only fires when the window is unfocused; user can disable entirely.

## Migration Plan

1. Database migrations are appended to the `MIGRATIONS` array in `server/db.ts`. They run on first launch of the new build with no user action.
2. The shell-integration toggle defaults to ON. On first spawn after upgrade, the user transparently gets the shim.
3. If the shim fails to bootstrap (sentinel-not-seen within 5s of first prompt), a one-time toast surfaces "Shell integration unavailable for this shell — features that depend on prompt marks are disabled. Settings → Terminal." There is no retry loop.
4. Rollback strategy: settings.toggle off shell integration → next spawn is a plain shell. Existing sessions are unaffected.
5. Bundle: `scripts/build-sidecar.mjs` learns to copy `server/shell-integration/*` into `src-tauri/binaries/shell-integration/` so the desktop build can locate the shims at runtime via `path.join(__dirname, 'shell-integration', …)`.

## Open Questions

- *Default font family.* Today we use `'DM Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace`. Do we ship a bundled font for ligatures (Cascadia Code? FiraCode?) or rely on the user having one? Provisional answer: rely on system fonts; document recommended fonts in settings; do not bundle in v1 to avoid licensing churn.
- *Image rendering size cap.* `addon-image` accepts a `pixelLimit`. What value pairs well with our default 320px panel height? Provisional: 8 megapixels per frame, 32 MB total in-flight cache; revisit after dogfooding.
- *Notification cadence dedupe.* If the same long-running command finishes twice in 30s (e.g. test runner watch mode), do we coalesce? Provisional: yes — debounce 5s on (sessionId, command) tuple.