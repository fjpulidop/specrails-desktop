## Context

Desktop owns the configurable Implement recipe; Core executes its declared graph. `correction-progress` currently accepts any unchanged correction when `verify.valid` is true. The supplied Windows log reaches 200 steps with 25 green verification passes and 24 corrections; it does not expose the structured reviewer verdict, so the exact review objection cannot be recovered from that text.

## Goals / Non-Goals

**Goals:** stop ineffective corrections promptly, bound changing corrections, keep acceptance gates intact, and expose current failure facts.

**Non-Goals:** change Core's runtime contract, weaken review thresholds, repair the user's game without its source, or mutate existing frozen runs.

## Decisions

- Require the fixer's actual candidate hash to differ from the verified candidate, regardless of host-check success. A claimed repair or a repeated green command is insufficient.
- Use Core's existing scoped assignments and conditions for a three-attempt correction budget. Initialize once after freezing artifacts; increment before each fixer call. Resume retains the counter. Budget exhaustion records the latest current review or verification diagnostics.
- State the unchanged review acceptance thresholds in reviewer and fixer prompts. Keep candidate-bound review capture and clearing so stale findings cannot obscure a new command failure.
- Include current review context, host-check state and fixer summary in the stalled terminal reason. Project durable workflow failure reasons into the bounded readable log without new transport fields.
- Extend deterministic executor fixtures with genuine no-op, changed repair and perpetual file-churn cases. Run the real Core CLI, OpenSpec, candidate hashing and host verification. Addendum fixtures must change actual candidate files before claiming that a previously missing delta was repaired.

## Risks / Trade-offs

- A fixer that disputes a review without making changes stops rather than buying another identical review. Its diagnosis remains visible for a human decision; it cannot certify acceptance itself.
- Three changed corrections may be insufficient for a larger defect. The terminal reason identifies exhaustion; a forked recipe can edit the declared correction limit.
- Frozen or forked older definitions retain their old graph. Newly launched built-in Implement runs receive this fix.

## Migration Plan

Ship the Desktop recipe and log projection together, retaining the published Core 6.2.1 pin. No database migration or existing-run rewrite is required.
