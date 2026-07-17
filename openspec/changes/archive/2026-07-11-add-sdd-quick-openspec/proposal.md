## Why

Specrails already supports heavy implementation rails, Freestyle rails, and an OpenSpec lifecycle loop, but the operator has no first-class path for a small change that must stay governed by OpenSpec. Users either pay the full architect/developer/reviewer cost for minor work, or risk using Freestyle without a hard guarantee that OpenSpec artifacts remain the source of truth.

This change introduces a lightweight spec-driven option for vibe engineering: small changes can move quickly, but code never changes OpenSpec contracts unless the OpenSpec artifacts are amended first.

## What Changes

- Add a built-in strategy named **SDD Quick (OpenSpec)** for small, OpenSpec-governed implementation work.
- Promote the existing OpenSpec lifecycle behavior into a first-class built-in rail/factory option instead of treating it only as a generic loop template.
- Require the operator to classify small work as either ticket-local/Freestyle-safe or OpenSpec-governed/SDD Quick before proposing a launch.
- For SDD Quick (OpenSpec), require the local ticket to reference or summarize the OpenSpec change being operated on, then launch an OpenSpec-aware loop that fast-forwards/amends artifacts, applies tasks, verifies against OpenSpec, and archives only after verification passes.
- Make Freestyle explicitly implementation-only when OpenSpec artifacts are relevant; Freestyle must not be recommended when the change alters OpenSpec contracts, requirements, design decisions, acceptance criteria, APIs, states, or invariants.
- Surface the launch recommendation to the user with the selected ticket, OpenSpec change, mode, engine, and cost/time framing, and require normal ai-spawn confirmation before execution.

## Capabilities

### New Capabilities
- `sdd-quick-openspec`: the first-class quick SDD strategy for OpenSpec-governed small changes, including operator classification, ticket/OpenSpec linkage, launch recommendation, and launch behavior.

### Modified Capabilities
- `factory-loops`: add or expose a first-class built-in factory option for SDD Quick (OpenSpec), distinct from Freestyle and the full Implement pipeline.
- `opsx-lifecycle-loop`: narrow and productize the existing OpenSpec lifecycle behavior for quick OpenSpec-governed changes, including its no-contract-drift rule and archive gating.
- `loop-magic-commands`: ensure the OpenSpec lifecycle commands remain available to the built-in strategy and carry the correct continuation/apply/verify semantics.

## Impact

- **Operator/MCP policy:** update the operator prompt/tool guidance so small work is classified before launch, and SDD Quick (OpenSpec) is recommended when OpenSpec artifacts are authoritative.
- **Rails/loops:** expose the built-in strategy through the same rail launch machinery that already handles factory loops, worktree isolation, run tracking, and PR decision cards.
- **Ticket handling:** local tickets remain the operational wrapper; for SDD Quick (OpenSpec), the ticket must identify the relevant OpenSpec change or describe the OpenSpec amendment being made.
- **OpenSpec artifacts:** SDD Quick (OpenSpec) may create or amend OpenSpec change artifacts before implementation, then verify implementation against those artifacts.
- **Out of scope:** changing specrails-core command internals, replacing Freestyle, bypassing ai-spawn confirmation, or allowing direct code edits outside rails/worktrees.
