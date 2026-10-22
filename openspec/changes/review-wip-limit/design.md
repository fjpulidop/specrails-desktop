## Context

The delivery lifecycle (`server/modules/delivery/domain/state.ts`) records the user decision on each `rail_pr_deliveries` row: `building → on_review → pr_draft → pr_ready → merged/completed`, plus the side states `no_changes`, `pr_closed`, `implementation_failed`, `pr_failed`, `discarded` and `superseded`. A grouped multi-repository delivery has one top-level parent and per-repository child rows (`parent_delivery_id`). Each rail slot owns at most one active top-level generation.

The daily budget gate from `rail-loop-budget-guard` (#791) already established the admission pattern. Every launch door ends at `POST /rails/:i/launch|relaunch`. A refusal returns a structured 409 before anything is spawned, and the gate is bound per project at composition (`ProjectContext`).

## Goals / Non-Goals

**Goals:** cap new review work per project, with the same 409 at every door; never block continuing work the user already owns; keep the cap exact under parallel launches.

**Non-Goals:** the cap does not cover standalone loop runs (Loops page) or loop resumes, which create no delivery. It is not an app-wide limit, and it does not auto-queue held rails for later.

## Decisions

1. **What counts.** Top-level rows in `building`, `on_review`, `pr_draft` or `pr_ready` count.
   - `on_review` is the undecided delivery. `pr_draft` and `pr_ready` are PRs created or continued by the app that are not merged or closed.
   - `building` counts because it lands on review once it settles. Counting it is the only way the cap holds when Launch all fans out N rails at once.
   - Not counted: `no_changes` (acknowledge only, nothing to review), `implementation_failed` and `pr_failed` (no reviewable result; they need a retry or a discard), `pr_closed` (closed on GitHub) and every terminal state.
   - Child rows never count separately: a grouped delivery is one review item.
2. **Continuation exemption.** A launch that continues an existing delivery replaces or reuses that delivery's review slot instead of adding one. These launches are exempt:
   - `revisionOfDeliveryId` (change request);
   - Relaunch of a recorded delivery (the attempt was admitted under the limit; the retry re-enters the slot it held);
   - an explicit `targetPrNumber` or a PR review `followUp` (the review item is that PR);
   - any launch on a rail that still owns an active delivery.
   The last case is safe because the route only lets such a launch through as that delivery's continuation (PR continuation, addenda, failed-attempt retry, preparation-failure relaunch). Any other launch is refused with `pr_decision_pending`.
   The exemption is a pure function (`launchAddsReviewWip`), so the route does not repeat the continuation rules.
3. **Gate composition.** `createReviewWipGate({ db, readLimit })` is created per project in the registry next to the budget gate and exposed as `ProjectContext.reviewWipGate`. The route runs budget first, then WIP; both share the same placement (after process admission, before relaunch restoration, worktree allocation, enqueue or `LoopRunManager.run`). The gate reads the limit through the project-settings SQLite adapter on every admission, so a settings change applies to the next launch.
4. **Reservations.** Reading the count and inserting the delivery row are separated by awaits (repository bases, Core capabilities, worktree allocation). The gate therefore records an in-memory reservation per admitted rail and releases it when the response finishes or the connection closes. By then the delivery row exists, or it never will. A reservation is not counted twice once its rail shows the new row. The state is per project and in memory: a restart loses only in-flight reservations, whose requests also die.
5. **Launch all.** The client launches only up to the remaining capacity. Rails that would open a new delivery take slots in board order; rails continuing their own delivery take none. The dialog says how many rails are held. At zero capacity it explains why and its Launch button is disabled, so nothing launches. This is simpler and more honest than launching everything and collecting 409s. The server still re-checks each launch, and any 409 is counted as "held by the review limit", not as a failure. MCP `launch_all` keeps its server-side fan-out: the reservations make it exact, and over-limit rails come back as `review-wip-limit` skips.
6. **Client mirror.** The badge and the disabled Play buttons count from the live per-rail snapshots (`RailPrDecisionContext`) with a mirrored decision set (`lib/review-wip.ts`), so they follow WebSocket updates without a refetch. The server stays authoritative. `GET /rails` also returns `reviewWip { limit, pending, reached }` for MCP `list` and other consumers.
7. **Fail-open.** An unreadable limit or snapshot admits the launch and logs a warning, mirroring the budget gate.
8. **`since`.** `since` is the delivery's admission time (`created_at`, normalized to ISO), because no decision timestamp exists yet. Task 1.4 adds those.

## Risks / Trade-offs

- **Two-step continuation.** A relaunch of a failed delivery can push the count over the limit, because the failed row is uncounted and the new attempt is `building`. This is intended: the work was admitted earlier.
- **Rows outside the PR flow.** Non-isolated or legacy (Loops off) launches create no delivery row. They hold a reservation only while the request is in flight and never count afterwards.
