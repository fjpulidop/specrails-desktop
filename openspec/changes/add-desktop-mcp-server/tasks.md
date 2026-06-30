## 1. Tray + background (component 0)

- [x] 1.1 Enable the `tray-icon` feature on the `tauri` crate in `src-tauri/Cargo.toml`
- [x] 1.2 Add `tauri-plugin-single-instance` and wire it so relaunch focuses the existing window
- [x] 1.3 Build the tray/menu-bar item with the app icon and an Open + Exit menu (macOS + Windows)
- [x] 1.4 Rewrite the `CloseRequested` handler in `src-tauri/src/lib.rs` to `prevent_close()` + hide the window (do NOT terminate the sidecar)
- [x] 1.5 Move sidecar termination to the tray Exit path (and true OS quit), preserving the identity-gated SIGTERM→SIGKILL / taskkill behavior and the parent-PID watchdog
- [x] 1.6 Keep the macOS regular activation policy (Dock retained)
- [x] 1.7 Add a Tauri IPC command to (re)build tray labels from the client's active language; default to English until the client reports it
- [x] 1.8 Client: push localized tray labels (Open, Exit, MCP status) on startup and on every language change
- [x] 1.9 Add tray label strings to all 8 locales (en, es, fr, de, pt, it, zh, ja) and extend the key-parity test
- [x] 1.10 Rust tests for the close→hide and exit→terminate paths; manual smoke on macOS + Windows

## 2. Embedded MCP server

- [x] 2.1 Add `@modelcontextprotocol/sdk` to the server dependencies
- [x] 2.2 Add the `mcp_enabled` app setting (default false) to `desktop_settings` and to `GET/PUT /api/settings`
- [x] 2.3 Mint and persist an MCP-scoped token (`~/.specrails/mcp.token`, 0600), separate from the master token, with a regenerate path
- [x] 2.4 Create `createMcpRouter(registry, deps)` and mount `/api/mcp` with its own raw-body handling BEFORE the global `express.json` parser (mirror `/otlp`)
- [x] 2.5 Boot/teardown the MCP transport on `mcp_enabled` toggle without a server restart (mirror the Mobile Gateway pattern)
- [x] 2.6 Implement the four-tier permission model (Read/Write/AI-spawn/Destructive) with server-side enforcement and an LLM-readable refusal naming the required tier
- [x] 2.7 Persist the per-tier toggles as app settings and expose them on `GET/PUT /api/settings`
- [x] 2.8 Implement `specrails_watch` bridging `202 + WebSocket` results to a settled tool result with a bounded `until` deadline
- [x] 2.9 Server tests: enable/disable lifecycle, token auth (valid/invalid/regenerated), tier enforcement, watch settle-on-done/error/timeout

## 3. Tool + resource catalog

- [x] 3.1 Define the domain-facade tool framework (per-domain tool with an `action` enum, tier declaration per action)
- [x] 3.2 Implement the per-project tools (specs, rails, jobs, chat, agents/profiles, plugins, jira, loops, code-read, setup, analytics) reusing the in-process managers
- [x] 3.3 Implement the app-level tools (projects, settings, budget/theme/language, webhooks, core-update, changes)
- [x] 3.4 Expose read state as MCP resources (projects, tickets, rails, jobs, analytics, guide)
- [x] 3.5 Implement `specrails_guide` (concepts, workflow, invariants — Claude-only features, priority/draft rule, provider gating)
- [x] 3.6 Implement `specrails_search` and `specrails_describe` meta tools
- [x] 3.7 Implement `specrails_select_project` (sticky active project) with explicit-id override
- [x] 3.8 Enforce the v1 coverage boundary: do NOT register terminal shell-exec, browser-capture, `code_write_file`, the `uv` installer, or the global marketplace mutation
- [x] 3.9 Server tests: catalog shape/bounded count, action routing, resource reads, project scoping, excluded-op absence

## 4. stdio bridge + packaging

- [x] 4.1 Create the `mcp-bridge/` workspace subpackage (`specrails-mcp`) — transparent MCP stdio↔HTTP relay using `@modelcontextprotocol/sdk` StdioServerTransport
- [x] 4.2 Read the MCP token from the local token file; never require it in client config
- [x] 4.3 Surface a clear "Specrails app not running" error when `127.0.0.1:4200` is unreachable
- [x] 4.4 Add a build script (esbuild) to bundle the bridge to a `.js` and copy it into `src-tauri/binaries/` (Option A: run by the bundled Node, no new codesign)
- [x] 4.5 Add the bridge to `bundle.resources` in `tauri.conf.json` so it ships in the app, packaged BEFORE signing/notarization (do not run `fix-desktop-bundle.mjs` afterward)
- [x] 4.6 Update `ci.yml` to typecheck/test/cover the `mcp-bridge` package
- [x] 4.7 Update `desktop-release.yml` to build + bundle the bridge; add a smoke test that the bridge starts with the bundled Node
- [x] 4.8 Bridge tests: relay round-trip, token injection, app-not-running error

## 5. Onboarding + docs (8 languages)

- [x] 5.1 Build the `Settings ▸ MCP` panel: explainer, enable toggle, four tier controls, copy-config + copy/regenerate-token
- [ ] 5.2 Generate the ready-to-paste client-config block with correct in-`.app` paths (bridge command) and the HTTP URL variant, no token in the bridge block — PARTIAL: panel emits `{command:'specrails-mcp'}`; needs the absolute bundled path (Contents/Resources/binaries/specrails-mcp.js + runtimes/node) once the Tauri host exposes SPECRAILS_BUNDLED_MCP_BRIDGE_PATH and GET /api/mcp-admin/config returns it
- [x] 5.3 Add the welcome-wizard MCP hint (mirror the existing `setup.welcome.jiraHint` pattern)
- [x] 5.4 Add a new `mcp` i18n namespace with all panel + hint strings, in all 8 locales, passing the key-parity test
- [x] 5.5 Write `docs/mcp.md` (what an MCP is, how to enable, what it exposes, the security tiers)
- [ ] 5.6 First-run tray tooltip explaining that close now minimizes to tray (behavior change) — not yet implemented
- [x] 5.7 Client tests for the MCP panel (toggle, tier controls, copy actions) meeting client coverage thresholds

## 6. Verification

- [x] 6.1 `npm run typecheck` clean across server, client, cli, and mcp-bridge
- [x] 6.2 `npm test` + `npm run test:coverage` (server ≥80%) and client `npm run test:coverage` (≥80%) all green
- [x] 6.3 `openspec validate add-desktop-mcp-server` passes
- [ ] 6.4 End-to-end manual check on a packaged build: enable MCP, connect a client via the bridge, run a read tool, enable Write and create a spec, confirm it appears in the GUI; close window → MCP still reachable; tray Exit → MCP unreachable — pending a real desktop build + external MCP client (automated E2E with the SDK client against the embedded transport IS covered by server/mcp/mcp-server.test.ts)
