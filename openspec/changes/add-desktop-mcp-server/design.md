## Context

Specrails Desktop is a long-lived local Express v5 server (the `specrails-server` sidecar) spawned by a Tauri host. It exposes ~254 operations across 12 domains over REST + a shared `/ws` WebSocket, bound to `127.0.0.1:4200`, behind a single static **master token** (`~/.specrails/desktop.token`, 0600) that grants everything (shell via terminals, AI-CLI spawns, fs reads, project admin). There is **no MCP server** today and `@modelcontextprotocol/sdk` is not a dependency — this is greenfield.

Two existing facts drive the design:
1. **The Mobile Gateway** (`server/mobile/`) already proves the pattern we need: a second, settings-gated listener inside the same sidecar, off by default, with its own scoped per-device tokens, tapping the same `broadcast()` bus. The MCP surface copies this shape.
2. **Closing the window kills the sidecar today** (`src-tauri/src/lib.rs` `CloseRequested → terminate_process(pid)`). There is no tray/background mode. An MCP that must be reachable "while the app runs in the background" therefore *requires* a system-tray presence first — it is component 0, not an optional extra.

The surface was mapped exhaustively (254 ops: 106 safe / 76 mutating / 22 destructive / 22 spawns-ai / 28 external; 86 WS event types). The danger distribution is what forces a permission model rather than a single on/off switch.

## Goals / Non-Goals

**Goals:**
- Let any MCP-capable client (Claude Desktop, Cursor, Cline, custom agents) drive ~100% of the platform's *control* surface while the app runs (window open or minimized to tray).
- One-click enablement from `Settings ▸ MCP`, with a ready-to-paste client config and the secret never landing in client config.
- A read-only-by-default posture with explicit opt-in tiers for write / AI-spawn (cost) / destructive actions.
- The external LLM "understands the platform" without hand-holding (a `guide` meta tool/resource).
- Multi-language onboarding (8 languages, key-parity) so users know what an MCP is, how to enable it, and what it grants.

**Non-Goals (v1):**
- Exposing the highest-risk *execution* vectors: terminal shell-exec, browser-capture, `code_write_file`, the `uv` `curl|sh` prerequisite installer, and the global `~/.claude/settings.json` marketplace mutation.
- Auto-connecting the in-app Specrails Chat to its own MCP (future).
- Publishing `specrails-mcp` to npm (the bridge is bundled; npm is a later option).
- Per-scope tokens beyond a single MCP-scoped token (no per-client tokens in v1).
- Linux tray support (the desktop release pipeline targets macOS + Windows).
- Background daemon that outlives a true app quit (MCP availability is tied to the app process).

## Decisions

### D1 — Embedded streamable-HTTP transport at `/api/mcp`
Mount the `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` as a settings-gated router on the existing Express app, sibling to `/api/mobile` and `/otlp`. It must be wired **before** the global `express.json(1mb)` parser (the SDK wants the raw stream), exactly as `/otlp` registers its own body handling first.
- **Alternatives:** stdio-only (forces a process per client, no direct path); deprecated SSE transport (`/sse`+`/messages`) (stateful, superseded); reusing `/ws` (it is a one-way event broadcast, not JSON-RPC — strictly worse). Chosen embedded HTTP because it reuses the running sidecar with full in-process access to `ProjectRegistry`/`QueueManager`/`ChatManager`.

### D2 — Enablement via a new `mcp_enabled` app setting (default off)
Persist `mcp_enabled` in `desktop_settings` (GET/PUT `/api/settings`), boot/teardown the MCP router on toggle without a server restart — mirroring `MobileGateway.isEnabledSetting()`. Read is always available when enabled; the other tiers are separate booleans.

### D3 — A new MCP-scoped token, never the master token
Mint a separate token for the MCP surface (`~/.specrails/mcp.token`, 0600), distinct from the all-powerful master token. The stdio bridge reads it locally; the HTTP path requires it as `Authorization: Bearer`. This follows the mobile per-device-token precedent and avoids handing third-party clients a token that also unlocks shell + arbitrary AI spawns.
- **Alternative:** reuse the master token (simplest, but any MCP client would then hold full-shell credentials — rejected).

### D4 — Domain-facade tool taxonomy (~21 tools), not 254 flat tools
Group the surface into ~16 domain tools, each with an `action` enum (e.g. `specrails_specs({action:'create'|'generate'|…})`), plus 3 meta tools (`guide`/`search`/`describe`), `specrails_watch`, and `specrails_select_project`. 254 first-class tools would saturate the LLM's context and degrade tool selection.
- **Alternatives:** one tool per operation (254 — context blow-up); core-typed + a generic `api_call` escape hatch (weaker typing for the long tail). Chosen facade for full coverage at a bounded tool count.

### D5 — Reads as MCP resources + a `guide` meta layer
The 106 read operations are exposed as MCP **resources** (`specrails://projects/{id}/tickets`, …) and also reachable via each domain tool's `list`/`get` action (clients differ in resource support). `specrails_guide` returns a living manual of the platform's concepts and invariants (rails, specs, drafts, profiles, providers, loops, the Claude-only features, `priority` null only on draft, provider gating) — this is what makes the LLM "understand how to operate it". The guide is English (machine-facing); human docs are localized separately (D11).

### D6 — `specrails_watch` bridges the pervasive `202 + WebSocket` pattern
22 operations return `202` and emit their real result only over `/ws`. A cost-incurring/streaming tool returns a handle (`jobId`/`requestId`); `specrails_watch({projectId, ref, until})` subscribes to the bus, accumulates deltas, and settles on `done`/`error`/`timeout`, returning the actual result to the LLM instead of a bare "accepted".

### D7 — Four-tier opt-in permission model
Map each operation's danger class to a tier: **Read** (always on), **Write** (mutating, non-destructive, non-spawn), **AI-spawn** (spawns-ai, costs money), **Destructive** (destructive + external-write). The server enforces tiers server-side and returns an LLM-readable refusal naming the tier to enable. External-read operations (probes, Jira discovery, core-update check) fall under Read; external-write (Jira connect/sync/create, webhooks test, core-update apply) under Write/Destructive as appropriate.

### D8 — stdio bridge `specrails-mcp` as a monorepo subpackage, Option A execution
Ship a thin, transparent stdio↔HTTP relay as a new `mcp-bridge/` workspace subpackage (it shares the endpoint + token-path contract with the server and is bundled in the app build anyway, so a separate repo would only add sync friction). It carries no business logic and does not know the tool catalog. **Option A:** ship it as a plain `.js` executed by the already-bundled Node (`runtimes/node/bin/node`) — **no new code-signing**; the Settings panel generates the client-config block with absolute in-`.app` paths.
- **Alternative (Option B):** compile to a standalone binary (pkg/SEA) → a new Mach-O requiring codesign + notarization like `pty.node`/`spawn-helper`. Rejected for v1 (more pipeline work, no benefit since the bundled Node is already signed).

### D9 — System tray is component 0
Add a tray/menu-bar item (macOS + Windows) by enabling the `tray-icon` feature on the `tauri` crate. Rewrite `CloseRequested` to `prevent_close()` + `window.hide()` (server stays alive); the sidecar is terminated only via the tray **Exit** item (or a true OS quit). Keep the macOS Dock (Regular activation, not Accessory). Add `tauri-plugin-single-instance` so relaunch focuses the existing window instead of fighting over port 4200. **Close-to-tray is always on** (Slack-style) per the product decision.

### D10 — Tray labels localized in all 8 languages via client→Rust IPC
The tray menu is built in Rust, which has no access to the client's i18next catalog. On startup and on every language change, the client pushes the localized labels (`Open`, `Exit`, MCP status) to Rust via a Tauri IPC command, which rebuilds the menu. Until the client connects, the menu shows English defaults.

### D11 — Multi-language onboarding is a first-class deliverable
A `Settings ▸ MCP` explainer panel, a welcome-wizard hint (mirroring the existing `setup.welcome.jiraHint` precedent), and a `docs/mcp.md` reference — *what an MCP is, how to enable it, what it grants, the security tiers* — all 8 languages, enforced by the existing locale key-parity test. New i18n namespace (e.g. `mcp`).

## Risks / Trade-offs

- **Autonomous LLM with destructive/cost power** → default read-only + explicit per-tier opt-in + `specrails_watch` cost surfacing; the four highest-risk execution vectors excluded from v1 entirely.
- **MCP token is still powerful within its tiers** → scoped token separate from master; regenerate button in the panel; loopback-only bind unchanged.
- **MCP only reachable while the app runs** → the bridge returns a clear "Specrails app not running (start the Specrails Desktop app)" error when `127.0.0.1:4200` is down; the tray keeps it alive through window-close.
- **Behavior change: close no longer quits** (BREAKING) → first-run tooltip on the tray + the onboarding panel explain it; rollback is reverting the `CloseRequested` handler.
- **Tray i18n race (Rust ready before client locale)** → default to English labels, relabel on the client's first IPC push.
- **Streaming bridge lifecycle** (WS subscribe/timeout/eviction) → bound `specrails_watch` with an `until` deadline and reuse the existing per-conversation/per-job settle events; never block indefinitely.
- **Bundle ordering** → the bridge must be packaged into `bundle.resources` **before** signing/notarization; do not run `fix-desktop-bundle.mjs` post-`tauri build` (it would re-sign and invalidate the updater `.app.tar.gz`).
- **Coverage gates** → the new `mcp-bridge` package and server router must meet the repo's coverage thresholds (70% global / 80% server); budget tests accordingly.

## Migration Plan

Additive and reversible:
1. Land the tray + single-instance + `CloseRequested` rewrite (`desktop-tray-background`, modifies `desktop-shell`) — independently shippable; gives background-run.
2. Land the embedded MCP server + scoped token + tiers (`desktop-mcp-server`) behind `mcp_enabled=off`.
3. Land the tool/resource catalog + `guide`/`watch` (`desktop-mcp-tools`).
4. Land the `mcp-bridge/` subpackage + bundling (`desktop-mcp-stdio-bridge`) + CI/CD changes.
5. Land onboarding panel + welcome hint + `docs/mcp.md` in 8 languages (`desktop-mcp-onboarding-docs`).

**Rollback:** set `mcp_enabled=off` (disables the whole MCP surface, no restart); revert the `CloseRequested` handler to restore kill-on-close. Frozen contracts (master token, mobile-ws wire compat, `sh.specrails.hub` bundle id) are untouched throughout.

## Open Questions

- Per-action confirmation via MCP **elicitation** for destructive ops (deferred — relies on client support; tiers cover v1).
- Whether to expose read-only terminal **command marks** (`list_command_marks`) under Read (low-sensitivity timing data) — leaning yes, but terminal shell-*write* stays out.
- Exact UX for surfacing a tier-refused error so the LLM relays "enable tier X" cleanly across clients.
- npm publish of `specrails-mcp` (timing + whether to gate behind the bundled path) — deferred past v1.
