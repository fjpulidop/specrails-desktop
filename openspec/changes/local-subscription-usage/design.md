## Context

Planning baseline: working tree inspected on 2026-09-30; numerous integration edits are already in progress. Only files inside this new change are authored by this proposal. Implementation is deliberately deferred until the user explicitly starts it after integration. Continue on the existing local branches; do not create remote branches, push or open a PR as part of this planning change.

Observed integration points:

- `server/desktop-router.ts` owns `/api/providers/detected` and `/api/runtime-providers`; detection broadcasts app-global `providers.detected_changed`.
- `server/provider-detection.ts` provides installation/version/auth hints. Some auth checks only prove a file exists; they do not prove a usable subscription login.
- `server/providers/codex-live-session.ts` already uses app-server stdio, bounded frames, command/environment helpers and process-tree cleanup. Its lifecycle belongs to an executing turn; do not call it to collect subscription usage.
- `client/src/features/providers/lib/provider-capabilities.ts` currently exposes Claude and Codex publicly and hides Gemini/Kimi. Local OpenAI-compatible engines are separate connections and have no subscription contract.
- `ArcSidebar` has a collapsed 44px rail, expanded 240px default and footer actions; `App` owns the global settings modal. `GlobalSettingsPage` currently permits only appearance/mobile as initial sections, and groups runtime providers under Specrails Agents.
- `client/src/lib/api.ts` explicitly reserves `getApiBase()` for projects and `API_ORIGIN` for app-global endpoints. This feature must use the global origin and existing authentication helpers.

Orca source evidence (reviewed in the preceding investigation; reverify when implementing): [Claude credentials](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-oauth-credentials.ts), [Claude OAuth usage](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-oauth-usage-request.ts), [Codex RPC probe](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-rpc-rate-limit-probe.ts), [Codex fallback orchestration](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-fetcher.ts), [shared representation](https://github.com/stablyai/orca/blob/main/src/shared/rate-limit-types.ts). These demonstrate a working approach in Orca; they do not establish a stable public API or tested compatibility in Specrails. No source code is copied.

## Goals / Non-Goals

**Goals:** Display authoritative account-wide consumed quota and known reset times for the current local Claude/Codex login; preserve missing values; provide useful loading/error/stale states; share one machine-scoped service across projects/windows; fit existing theme/i18n/accessibility patterns.

**Non-Goals:** Implementation during this planning request; account vault/switching/login; durable history/charts; API cost estimation; queue admission, automatic provider changes or job cancellation; paid prompt probes; Cursor/Kimi/Gemini; WSL/remote/SSH account discovery; a Core execution contract change. Local engines have no synthetic subscription row.

## Decisions

### 1. Capability ownership and account scope

Add `server/modules/subscription-usage/` with `domain.ts` for schemas/window normalization, `ports.ts` for an injected provider usage reader and clock, `application.ts` for snapshot/refresh policy, `runtime/usage-service.ts` for in-flight/cache/timer ownership, and focused `adapters/claude.ts`, `adapters/codex.ts`, `adapters/http.ts`. Public `index.ts` exposes contracts and service creation without starting probes at import time. Instantiate once per desktop server, inject detection/command/HTTP/credential effects at composition, dispose on shutdown. Add a README, reviewed manifest entries, fixed core dependency rules and source map when implementation adds files.

The service owns only host/account usage; never stores project IDs, project DB handles, conversation logs or project budget data. Key cache by provider + resolved auth context + opaque account generation, rather than connection ID or active project. Multiple configured connections using the same login share a snapshot. Project switching does not reset this global cache. A different backend host starts a distinct client/service cache.

Alternative considered: extend every `ProviderAdapter` with quota methods. Rejected for v1 because execution and account subscription access are independent capabilities, and most providers cannot satisfy this contract. Reuse existing provider strategies/helpers where relevant without widening their mandatory interface.

### 2. Contract and missing-value semantics

Proposed public shape (types are design notation, not source implementation):

```ts
type UsageWindow = {
  id: string; label: string; scope: 'account' | 'model'; model: string | null;
  usedPercent: number | null; durationMinutes: number | null;
  resetsAt: string | null; // validated ISO UTC
};
type ProviderUsage = {
  providerId: 'claude' | 'codex'; generation: string;
  availability: 'available' | 'signed-out' | 'unsupported-auth' | 'unsupported-cli'
    | 'unsupported-platform' | 'unavailable';
  refreshState: 'idle' | 'refreshing' | 'error';
  freshness: 'unknown' | 'fresh' | 'stale';
  plan: string | null; windows: UsageWindow[];
  source: 'oauth' | 'app-server' | null;
  observedAt: string | null; attemptedAt: string | null; retryAt: string | null;
  issue: { code: string; retryable: boolean } | null;
};
type UsageSnapshot = { scope: 'machine'; revision: number; providers: ProviderUsage[] };
```

Do not return credentials, filesystem paths, raw account IDs, emails, raw provider responses or stderr. `generation` is a service-local opaque value for invalidation, not a reversible account identifier. Plan names are displayed only when reported by the provider; missing plan is omitted, never inferred from quota. Stable window IDs preserve React row identity; retain unfamiliar named/model windows in provider order rather than hardcoding Fable/Sonnet/Opus.

Validate provider responses at the adapter boundary. Finite percentages in [0,100] are valid; invalid/missing percentages become null, never zero. Missing/invalid reset timestamps and durations become null independently. Zero is a valid measurement. Unknown window scope/model is normalized conservatively. Use provider duration/scope metadata, not primary/secondary position, to distinguish 5h and weekly; unknown duration gets a generic label. Convert provider Unix seconds to ISO explicitly. Reject oversized responses and unsupported overall shapes without inventing values.

### 3. Provider acquisition, compatibility and credentials

**Claude:** Resolve the active host auth context (including a supported `CLAUDE_CONFIG_DIR` override after confirming installed CLI behavior). On macOS read the correct Claude Keychain service without interactive prompts; fall back to the active config directory's `.credentials.json` when applicable. Linux/Windows use the CLI's verified file-backed OAuth credentials where supported. The adapter uses the active OAuth access token to GET `https://api.anthropic.com/api/oauth/usage`; verify required beta/User-Agent headers against current CLI/provider behavior before release. Map provider windows, including any supported model-specific windows.

Read credentials on each scheduled refresh and track a non-exported auth fingerprint. Do not implement token refresh, login, credential writes, browser cookie extraction or automatic Keychain authorization. A denied/unavailable Keychain yields an actionable state, with file fallback only for the same resolved context. API-key-only login produces unsupported-auth. 401/403 invalidate cached account figures and request sign-in/permission remediation; do not retry continuously or expose provider response bodies.

**Codex:** Prefer a short-lived read-only `codex app-server --listen stdio://` connection using existing command/environment and Windows spawn helpers. Protocol: initialize → initialized → `account/read` (to establish identity/auth/plan where supported, without requesting an explicit token refresh) → `account/rateLimits/read` → bounded shutdown. Confirm methods and optional multi-limit response fields against the installed/generated CLI protocol; never start a thread or turn. Honor the same supported host `CODEX_HOME` as execution. Use account identity only inside the adapter/service for cache invalidation. For active-account authentication changes, discard old generation results even if they arrive later.

Do not reuse `runCodexLiveSession`, since it owns execution. Reuse narrow process utilities; extract transport mechanics only if meaningful and protect existing cancellation/settlement with regression tests. Unsupported RPC/version reports unsupported-cli; it does not silently scrape terminal output. Orca's backend `wham/usage` and PTY fallbacks are deferred because they add credential/protocol maintenance; RPC is the v1 release gate. If RPC cannot report an authoritative window, show unavailable.

Default limits: HTTP timeout 10s; credential subprocess 3s; app-server initialization 10s, query 10s, total probe 25s; bounded read (HTTP 1MiB; RPC frame 1MiB; stderr ring 16KiB). On success, failure, abort and server shutdown remove listeners/timers and terminate only the owned probe process tree. No project files, plugins, MCP tools, prompts or usage logs are read for quota reconstruction. Verify CLI startup configuration can avoid irrelevant startup effects with supported flags; do not invent version-specific flags.

### 4. Refresh, cache and identity correctness

HTTP contracts under the existing authenticated desktop `/api` router:

- `GET /api/subscription-usage`: return current snapshot immediately; no provider network/subprocess work.
- `POST /api/subscription-usage/refresh` body `{ providerId?: 'claude' | 'codex' }`: validate body, schedule/join bounded refresh, return HTTP 202 with `{ snapshot, scheduled, retryAt }`. Unsupported/unknown provider input → 400; transient provider failure stays inside its row, not a global HTTP 500. Empty body refreshes supported detected public providers; missing/uninstalled supported providers remain descriptive rows without spawning.

POST is a read-only refresh of observed provider state, but uses existing mutation-route authentication/CSRF conventions. Do not accept arbitrary credential paths, binary names, URLs or auth tokens. No new WS contract in v1: client uses a shared store and GET polling. This avoids broadcasting account state to project streams.

One in-flight probe per auth context; refresh all runs at most two providers concurrently, and failure in one does not fail the other. A refresh request while busy joins existing work. Minimum provider refresh interval 30s, including manual clicks. Automatic refresh eligible every 120s while a usage surface is visible; pause when document/window hidden or no surface mounted. While refresh is active, GET poll every 1s, stop at settled state or 30s and show delayed/error information. Poll idle snapshots every 30s only while visible; all mounted consumers share these timers. Server has no permanent autonomous polling timer.

Freshness expires after 5 minutes from successful observation. Display last success alongside a transient error only within the same verified auth generation. Authentication changes/signed-out/permission failures immediately clear figures; network/server failures preserve same-account figures as stale. Never extend `observedAt` on failure. A known reset time passing marks that window stale immediately; show 'Reset reached; refresh to confirm', never locally set usage to zero.

Rate limit 429 honors Retry-After with a safe minimum 30s; without a valid value use 60s. Network/5xx failures back off 30s, 60s, 120s, 240s, then 300s maximum; success resets backoff. Manual refresh respects backoff. Auth and unsupported states suspend automatic retry until explicit refresh or relevant detection/auth-context change. Probe auth context immediately before and after acquisition; changes advance generation, invalidate old figures and discard in-flight old-generation results. Subsequent identity verification also invalidates snapshots when CLI internally changes accounts. If same identity cannot be established after an auth failure, fail closed for cached figures. Data collection never gates provider detection or execution.

### 5. Frontend ownership and placement

New `client/src/features/subscription-usage/` owns API/schema validation, shared store/hook, `SubscriptionUsageSection`, `SubscriptionUsageTrigger`, `SubscriptionUsagePanel`, window row and formatting helpers. Public focused subpaths declared in boundaries; settings and application shell import public components. Existing providers feature supplies public visibility/capability information only through its reviewed subpaths. Use `API_ORIGIN` and existing authenticated fetch conventions, never bare relative fetch or `getApiBase()` for this global feature.

Mount a dedicated 'Usage' section in the left ArcSidebar above the footer actions. Expanded: section heading with refresh action and exactly two compact provider rows, Claude then Codex. Each row shows named window percentages separately, wrapping at the sidebar's minimum width; clicking it opens that provider's details. Unknown or signed-out rows show a short state instead of invented percentages. Keep this section visible without an active project. Collapsed: one accessible Usage icon and tooltip opens the panel containing Claude and Codex only. A warning dot uses only fresh known quota >=90%. Do not add other providers, even if public provider visibility changes later. Never sum or average windows/providers. Portal the popover outside sidebar overflow and prevent hover collapse from unmounting an open/focused panel.

Popover title: 'Subscription usage'; subtitle: 'Accounts signed in on this computer'. Width 380px, max-width viewport minus 24px; max-height min(560px, viewport minus 32px); content scrolls. Header has refresh button and Detailed/Compact segmented control. Default Detailed, preference saved client-side by view preference only (no usage data persistence). At narrow widths use the existing dialog primitive with full available width. Escape closes and returns focus; outside click dismisses; keyboard opens from the trigger. Details replace the selected provider inside the same popover with a Back control, avoiding nested dialogs.

Detailed rows: provider icon/name, reported plan chip, freshness text; each account/model window has readable label, 6px progress bar, consumed percentage and reset description. Compact rows retain every available window with short labels and percentages; never conceal a model-specific quota behind one aggregate. Unavailable/error rows stay visible for Claude/Codex with one-line explanation and an appropriate action. Refresh preserves measured rows; initial load uses stable-height placeholders.

Footer 'View details' opens a new 'Subscription usage' section in the existing app settings modal. Extend `initialSection` through App and modal props; do not turn app settings into a route or navigate to project `/settings`. Settings panel expands provider rows with absolute reset time, last successful update, data source in a secondary disclosure and a brief explanation that usage includes activity outside Specrails. 'Manage providers' opens the existing Specrails Agents/providers pane. It does not promise account switching or a new login system. No history link appears in v1.

### 6. Visual language, copy and accessibility

Static layout reference: `visual-design.svg`, with a rendered preview in `visual-design.png` (illustrative figures, not live quota). Wireframes below define behavior independent of mock styling:

```text
[Left sidebar: Usage / Claude / Codex] ──> Subscription usage                 [Refresh]
                   Accounts signed in on this computer
                   [ Detailed selected | Compact ]
                   Claude · Max (if reported)       Updated 1m ago
                   5 hours   [██████░░░░░░]  62% used
                             Resets in 28m
                   7 days    [████████░░░░]  81% used
                             Resets Friday, 14:00
                   Codex · Plus                      Updated 1m ago
                   7 days    [██░░░░░░░░░░]  23% used
                             Resets in 6d 7h
                   [View details]            [Manage providers]
```

Use existing `bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`, `accent-primary`, `accent-warning` and destructive tokens, UI primitives and Lucide icons. Do not copy Orca's fixed-black palette. Use 16px panel padding, 12px row gaps, 14px provider titles, 12px labels and tabular numerals; a quiet border separates providers. Bar 0–79% uses accent-primary, 80–89% warning, >=90% destructive; 100% adds 'Limit reached'. The warning dot uses only fresh known values. Stale figures use neutral muted styling plus explicit 'Out of date', avoiding a current-looking warning. Provider identity never depends solely on brand color.

Always show 'used' to avoid ambiguity about remaining allowance. Missing percentage → em dash + 'Usage unavailable', no determinate bar. Known usage/unknown reset → 'Reset time unavailable'. Unknown plan → no chip. No windows on API billing → 'Usage is not available for this login'. Signed out → 'Sign in with the Claude/Codex CLI, then refresh'; permission issue → 'Local sign-in could not be read'; transient failure with cached figures → 'Could not refresh · showing data from …'. First-run empty state explains supported local logins and provides Manage providers; local-only users see no fake 0% row for their engine.

Relative time formats use i18n pluralization; detail tooltips show an absolute local date/time and timezone. A shared minute tick updates labels only while visible; server values remain UTC. All app-supported locales get keys; strings are not built by concatenating English fragments. Light/dark/effect themes, 200% zoom, reduced motion and long translations must remain legible. Numeric progress uses accessible progressbar names and aria-valuenow; unknown progress has no misleading numeric ARIA value. Refresh has an accessible label and busy state; one polite status region announces completion/errors, not every countdown tick. Minimum 32px action targets, visible focus, logical tab order and no hover-only essential information.

## Risks / Trade-offs

- [Provider endpoints/protocols change] → Compatibility fixtures, shape validation, version gates and visible unavailable state. Validate current provider behavior after integration; no unsupported scraping fallback.
- [Token permissions/Keychain differ across installations] → Same-context credential lookup, bounded noninteractive reads, no credential mutation and explicit remediation.
- [Account changes while refresh is in flight] → Generation checks and cache invalidation before/after acquisition; tests include old replies arriving late.
- [RPC extraction perturbs live execution] → Reuse narrow existing utilities; avoid live-turn entry point and run existing Codex cancellation/settlement regressions if shared code changes.
- [Freshness is bounded, not continuous] → Display observation time, stale state and explicit refresh; no claim to real-time remaining quota.
- [Active integration moves entry points] → Mandatory rebaseline task before implementation, preserve decisions but revise source mapping and boundary dependencies.
- [No multi-account history in v1] → UI labels active local login and current snapshot, not all accounts or subscription history.

## Migration Plan

No schema migration or persisted credential store. Add module/feature behind composition after compatibility gates pass, validate docs/boundaries and enable both surfaces together. Unsupported provider/platform combinations degrade independently. Rollback removes UI mount and service wiring; dispose probes/timers, with no project data conversion. If shared Codex utilities were extracted, retain their execution behavior and public compatibility during rollback.

## Open Questions

These are implementation evidence gates, not user approval requests:

1. After pending integration, does Core own a reusable read-only Codex RPC client? Prefer its public compatible API if it offers isolation, abort and cleanup guarantees; otherwise use the Desktop adapter outlined above.
2. Which installed Claude versions/config directories expose OAuth usage and which macOS Keychain service names match them? Verify with synthetic fixtures and an explicitly authorized local smoke test when implementation starts; do not read credentials during planning.
3. Does the paired Codex protocol expose multiple limit groups/model scopes and plan via account/read? Preserve them when available; never assume only two windows.
4. Which platform combinations meet the compatibility gate? Define a supported matrix from actual evidence; untested combinations remain unsupported rather than advertised working.

## Implemented UX revisions

Implementation was explicitly authorized after integration, on the existing local branch. The final UI always uses detailed windows and ignores the former view preference. Both panels omit View details and Manage providers. Sidebar provider cards have icons, separate labeled percentages and progress bars; the no-CLI state offers explanation and refresh only. Claude breakdown containers without measurement/reset fields are ignored, while actual windows with missing values remain unknown. The original wireframe above is a historical planning reference superseded by these revisions.

### Final simplification
The user removed the duplicate floating panel. Sidebar provider cards are informational and do not open a popover. The collapsed rail shows a status icon; detailed reset information remains in global settings. This supersedes the earlier popover and focus-restoration design.

Opening the Usage section requests a refresh each time, retaining cached measurements while collection runs and respecting service cooldowns. Closing it does not request a refresh.

Final placement: Usage is in the shared footer status bar in board and mission modes, removed from the left sidebar. Hover, focus or click opens the provider cards above the footer; opening requests refresh. Pointer transfer to the menu stays open, leaving dismisses after a short delay, and Escape/outside interaction closes it. Mission mode uses the minimal status bar without spend polling. This supersedes prior sidebar placement.

Footer summaries show one quota per provider: account weekly when reported, otherwise the first account window, otherwise the first reported window. Values are never aggregated. The hover menu shows every individual quota and bar. There is no presentation selector or mode label.
