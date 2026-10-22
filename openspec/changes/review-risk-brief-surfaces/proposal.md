## Why

External feedback (2026-10, task 1.2) says the review packet makes a human read measured facts and agent prose before learning where the risk is. Core PR #436 (contract 5.3, capability `reviewBrief: 1`) makes the reviewer return an advisory brief next to its verdict: behaviour changes, invariants touched, untested paths, up to five severity-ordered risks with `file:line` refs, human checks and (Phase 3) spec divergences. Desktop must put that brief first wherever a person decides on a delivery, without changing anything for Cores or runs that do not produce it.

## What Changes

- **Harvest.** At settle, when the active Core announces `reviewBrief: 1`, read the brief per unit from `<pipeline>/<runId>/review-brief.json` (engine 1), the engine 2 committed reviewer scope output (`review.brief`), or `confidence-score.json` → `brief`, normalize it tolerantly and store it as `reviewBrief` inside the existing `settle_evidence` JSON. No migration. Packet opening heals older rows the same way.
- **Packet.** New first section **What to look at**, right after the verdict and before the measured facts, in a fixed order: risks (high first), behaviour changes, invariants touched, untested paths, human checks (plus divergences when present). A note appears when Core dropped the brief or Desktop could not read it. Hidden when there is no brief. The packet API also exposes `riskSummary` (counts per severity + top risk) as a cheap analytics hook.
- **PR body.** A short `## What to look at` block under the summary with high and medium risks, untested paths and human checks; the cost footer is unchanged; nothing when there is no brief.
- **Cards.** Delivery snapshots, `rail.pr_state` and the mission card envelope carry `riskSummary` only when a brief exists; the mission card and the dashboard strip show the top risk (severity chip + text).
- **i18n and docs.** Eight locales; `docs/internals/review-packet.md`, `docs/internals/safe-pr-review-flow.md`, the delivery module README and the in-app guide.

## Capabilities

### Modified Capabilities

- `review-packet`: the packet opens with the reviewer's risk brief when one exists; the PR body and delivery cards summarize it.

## Impact

- Server: `server/modules/delivery/runtime/{review-brief,delivery-evidence,review-packet,pr-body,rail-pr-store,rail-isolated-launch,rails-router}.ts`, `adapters/decisions/create.ts`, `server/types.ts`.
- Client: review packet page, `WhatToLookAt`, `TopRiskLine`, mission PR card, dashboard strip, wire coercion, `packet` locales.
- No database migration, no new endpoint, no change to decisions, the approval gate or Core.
