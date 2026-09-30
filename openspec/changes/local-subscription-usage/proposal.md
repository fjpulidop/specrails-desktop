## Why

Users with Claude or Codex subscriptions cannot see their account allowance and reset times inside Specrails. Job token/cost accounting cannot reconstruct provider-wide subscription consumption, so users must leave the app to decide whether they have headroom to continue.

## What Changes

- Add read-only subscription usage for the active local Claude and Codex login, reporting consumed percentages, provider-defined windows, reset times and freshness.
- Add a Usage section in the left sidebar with Claude and Codex rows only, a detailed/compact popover, and an expanded Subscription usage panel inside app settings.
- Normalize supported provider responses while distinguishing unknown values, signed-out sessions, unsupported authentication, stale snapshots and errors.
- Refresh on visible demand with bounded background polling, cancellation, deduplication and provider backoff; keep credentials exclusively on the server.
- Document compatibility gates and a post-integration implementation checkpoint. This change is planning only until explicitly started.

## Capabilities

### New Capabilities

- `local-subscription-usage`: Machine/account-scoped read-only collection, normalization, cache, lifecycle and HTTP contract for Claude and Codex.
- `subscription-usage-ui`: Global, accessible consumption/freshness presentation and settings navigation.

### Modified Capabilities

None. Provider detection, execution availability, cost accounting and project settings retain their existing contracts.

## Impact

- Proposed server owner: `server/modules/subscription-usage/`; composition through `server/index.ts` and the desktop router before project routes.
- Proposed client owner: `client/src/features/subscription-usage/`; public components mounted by `ArcSidebar`, `App` and the global settings modal.
- Reuse provider detection, command/process resolution, API origin/auth conventions, UI primitives, themes and i18n; review and declare module/feature boundaries during implementation.
- Claude uses locally available OAuth credentials and a provider usage endpoint; Codex prefers read-only app-server RPC. Provider compatibility is a release gate, not assumed from Orca alone.
- No project DB migration, billing estimates, durable usage history, account switching, new provider integrations, prompt probes or queue policy changes in v1.
- Preserve existing uncommitted work. Re-evaluate provider visibility, settings layout and Core/runtime transport after the user's pending integrations land.
