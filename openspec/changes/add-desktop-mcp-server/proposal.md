## Why

External LLM clients (Claude Desktop, Cursor, Cline, any MCP-capable agent) cannot read or control Specrails Desktop today — the app's entire control surface (~254 operations) lives behind a loopback REST/WebSocket API guarded by a single all-powerful token, with no MCP server of any kind. We want **any MCP client to drive 100% of the platform** — specs, rails, jobs, chat, analytics, agents, plugins, Jira, loops, settings — with one-click setup from the app. Two things make that possible and safe: (1) the app must keep running in the background while its window is closed (a system-tray presence), and (2) users need clear, multi-language onboarding explaining what an MCP is, how to enable it, and exactly what it grants.

## What Changes

- **Embedded MCP server** at `/api/mcp` (streamable-HTTP via `@modelcontextprotocol/sdk`), mounted inside the existing sidecar and gated by a new app setting `mcp_enabled` (default **off**) — mirroring the existing Mobile Gateway opt-in pattern. Authenticated by a **new MCP-scoped token**, distinct from the all-powerful master token.
- **~21 domain-facade tools** (each with an `action` enum) + MCP **resources** + a **`guide`/`search`/`describe`** meta layer, covering ~100% of the control surface without flooding the LLM's context. A **`specrails_watch`** tool bridges the app's pervasive `202 + WebSocket` async pattern so cost-incurring/streaming operations settle to a real result instead of a bare "accepted".
- **Four-tier opt-in permission model** surfaced in `Settings ▸ MCP`: **Read** (always on), **Write**, **AI-spawn** (costs money), **Destructive**. The server refuses any tool whose tier is disabled, with an LLM-readable error.
- **`specrails-mcp` stdio bridge** — a thin, transparent stdio↔HTTP relay shipped as a new `mcp-bridge/` subpackage, **bundled with the app** and executed by the already-bundled Node runtime (no new code-signing). Gives universal client compatibility and keeps the token out of client config.
- **System-tray / menu-bar presence** (macOS + Windows): closing the window now **minimizes to tray** (the server keeps running); the app only quits via the tray **Exit** item. **Single-instance** enforcement so relaunching focuses the existing window. **All tray menu labels localized in the 8 supported languages.**
- **BREAKING (behavior):** closing the main window no longer terminates the server sidecar.
- **Multi-language onboarding:** a `Settings ▸ MCP` explainer panel, a welcome-wizard hint, and a `docs/mcp.md` reference — *what an MCP is, how to enable it, what it grants, security tiers* — in **all 8 languages with key-parity**.
- **Out of scope (v1):** terminal shell-exec, browser-capture, `code_write_file`, and the `uv` prerequisite `curl | sh` installer are **NOT** exposed via MCP (highest-risk execution vectors, low management value).

## Capabilities

### New Capabilities
- `desktop-tray-background`: system-tray/menu-bar item on macOS + Windows; close-to-tray (server stays alive), quit only from the tray; single-instance; tray labels localized in all 8 languages; the app runs in the background.
- `desktop-mcp-server`: the embedded MCP gateway — `/api/mcp` streamable-HTTP transport, `mcp_enabled` gate, MCP-scoped token, four-tier permission enforcement, the `specrails_watch` WS→result bridge, and lifecycle (boot/teardown tied to `mcp_enabled`).
- `desktop-mcp-tools`: the tool/resource catalog — ~21 domain-facade tools (action enums), MCP resources, the `guide`/`search`/`describe` meta layer, the danger→tier mapping, and the documented v1 coverage boundary.
- `desktop-mcp-stdio-bridge`: the `specrails-mcp` bridge binary — transparent stdio↔HTTP relay, reads the MCP token locally, bundled and run by the app's Node runtime, clear "Specrails app not running" error.
- `desktop-mcp-onboarding-docs`: the human-facing, multi-language onboarding — `Settings ▸ MCP` explainer, welcome-wizard hint, and `docs/mcp.md`, all 8 languages with key-parity, plus the ready-to-paste client-config block.

### Modified Capabilities
- `desktop-shell`: the **"App shutdown stops the server"** requirement changes. Closing the main window SHALL minimize the app to the tray and **leave the sidecar running**; the sidecar is terminated only when the user chooses **Exit** from the tray (or the OS truly quits the app). The parent-PID watchdog and force-kill-on-true-quit behavior are retained.

## Impact

- **Dependencies:** add `@modelcontextprotocol/sdk` (root/server). New `mcp-bridge/` workspace subpackage.
- **`src-tauri/`:** enable the `tray-icon` feature on the `tauri` crate; add `tauri-plugin-single-instance`; rewrite the `CloseRequested` handler (minimize-to-tray, not kill); add an IPC command to (re)localize tray labels from the client's active language.
- **Server:** new `/api/mcp` router mounted **before** the global `express.json` parser (like `/otlp`); new MCP-scoped token alongside `loadOrGenerateToken`; `mcp_enabled` setting; tier-enforcement middleware; the WS→tool-result bridge feeding `specrails_watch`.
- **Client:** `Settings ▸ MCP` panel (enable toggle, tier checkboxes, copy-config / copy-token), welcome-wizard hint, new i18n strings across 8 locales, extend the key-parity test.
- **CI/CD:** `ci.yml` runs typecheck/test/coverage for `mcp-bridge`; `desktop-release.yml` packages + bundles the bridge into `bundle.resources` **before** signing/notarization (must not run `fix-desktop-bundle.mjs` after). `release.yml` (npm publish) unchanged in v1 — publishing `specrails-mcp` to npm is deferred.
- **Docs:** new `docs/mcp.md` + localized in-app help.
- **Frozen contracts preserved:** the master token and `/api/token`, the Mobile Gateway wire compat, and the `sh.specrails.hub` bundle identifier are untouched.
