# Proposal

## Why
Desktop PR titles and delivery commits currently use subjects that release-please cannot classify. New deliveries need Conventional Commits on both surfaces so squash, merge and rebase preserve release-relevant feature and fix information.

## What Changes
- Format new PR titles as `type[!]: change (ref)`, retaining ticket/Jira references, batch counts and the 100-character cap.
- Share pure formatting and validation across implementation, partial, CI, recovery and local-restore commits; move run identity into a `Run: <runId>` body line.
- Honour breaking labels for completed implementations; use non-breaking `chore:` for incomplete runs and housekeeping.
- Preserve branch names, PR creation signatures, failure-tolerant ticket reads and settlement ownership/replay.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `safe-pr-workflow`: add naming requirements for Desktop-generated PR titles and delivery commits; preserve existing requirements.

## Impact
Delivery naming, isolated settlement/reconstruction/replay, PR CI, follow-up recovery, local restore and runtime continuation settlement. Adjacent tests, delivery guides and dependency metadata change. No UI, locale, dependency, database schema or release workflow changes. Core-agent PRs, history rewrites and enforcement tooling remain out of scope. The real Release PR outcome is observed after shipping.
