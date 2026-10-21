## Why

Parallel rails can produce deliveries faster than a person can review them. Launch all, MCP `launch_all` and mobile launches keep adding work while earlier deliveries still wait for a decision or an open PR still waits for a merge. Review becomes the bottleneck, and unreviewed work piles up. This is Phase 1 task 1.3 of the feedback-2026-10 program.

## What Changes

- **Project setting.** `reviewWipLimit` is an integer from 1 to 100, or `null`. `null` means no limit and is the default. It goes through the project-settings domain, port and SQLite/HTTP adapters (`config.review_wip_limit`). The settings UI suggests 5 and explains in one help sentence what counts.
- **Pure count.** The delivery domain gains `listPendingReview` / `countPendingReview` over a narrow delivery snapshot. These count top-level deliveries in `building`, `on_review`, `pr_draft` or `pr_ready`. A SQLite adapter reads that snapshot from `rail_pr_deliveries`.
- **Launch gate.** `POST /rails/:i/launch` and `/relaunch` are the routes every door uses (dashboard Play, Launch all, mission cards, MCP `launch`/`launch_all`, mobile and milestone chains). They now check the limit after the daily budget gate. When a new delivery would exceed the limit, they return `409 { error: 'review_wip_limit_reached', limit, pending: [{ deliveryId, railIndex, ticketIds, since }], detail, action }` and spawn nothing. Continuations of an existing delivery are exempt. While a launch is in flight, a per-project reservation holds its slot, so parallel launches cannot overshoot the limit.
- **Board.** The rails header shows an "In review 3/5" badge, and clicking it lists the pending deliveries. At the limit, every rail whose launch would open a new delivery has its Play button disabled, with a tooltip that explains why. Launch all starts only up to the remaining capacity, in board order. Its dialog says how many rails are held back; at zero capacity it launches nothing.
- **MCP, mobile and missions.** MCP `launch_all` maps the 409 to a `review-wip-limit` skip. `list` exposes `reviewWip`. Mobile relays the same body. The mission operator prompt gains one rule that explains the refusal to the user. The mission launch card and Relaunch show localized copy.

## Capabilities

### New Capabilities
- `review-wip-limit`: a per-project cap on deliveries waiting for review, enforced at every rail launch door, with continuation exemptions and board, MCP and mobile surfaces.

## Impact

- **Server:** `modules/project-settings` (domain, SQLite adapter), `modules/delivery` (`domain/review-wip.ts`, `adapters/review-wip-store.ts`, `runtime/review-wip-gate.ts`, `rails-router.ts`), `project-registry.ts` (`ProjectContext.reviewWipGate`), `mcp/tools/rails.ts`, `missions/runtime/agent-operator-prompt.ts`.
- **Client:** `lib/review-wip.ts`, `RailsBoard`, `ReviewWipBadge`, `RailControls`, `RailRow`, `LaunchAllDialog`, `DashboardPage`, `ProjectSettingsSections` (settings page and dialog), `AgentRailLaunchCard`, `AgentPrDecisionCard`, and locales (common, dashboard, agent, settings ×8).
- No migration: the setting is a `queue_state` key, and the count reads existing columns.
