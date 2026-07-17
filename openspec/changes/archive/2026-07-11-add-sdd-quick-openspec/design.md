## Context

Specrails Desktop currently has three relevant layers for this problem:

- `specrails_specs` can create or update the local ticket that acts as the operational wrapper for work.
- `specrails_rails` can assign tickets to rails and launch `implement`, `batch-implement`, `freestyle`, or `loop`.
- The loop system already contains OpenSpec lifecycle building blocks: `{{cmd:opsx:ff}}`, `{{cmd:opsx:apply}}`, `{{cmd:opsx:verify}}`, and `opsxLifecycleGraph()`.

The gap is not raw execution. The gap is product policy. Small work needs a path that is faster than the full implement pipeline but still treats OpenSpec artifacts as the contract when OpenSpec is in play. Freestyle is useful for implementation-only work, but it should not be the default answer when a code change would alter or depend on OpenSpec requirements, designs, acceptance criteria, APIs, states, or invariants.

## Goals / Non-Goals

**Goals:**
- Introduce **SDD Quick (OpenSpec)** as a first-class quick strategy for OpenSpec-governed small changes.
- Keep all code execution inside existing rails/worktree/job tracking.
- Make the operator update or create the local ticket before launch.
- Preserve OpenSpec as the source of truth: code changes that alter OpenSpec contracts must first amend OpenSpec artifacts.
- Allow existing OpenSpec lifecycle machinery to be reused instead of creating a parallel implementation engine.

**Non-Goals:**
- Do not replace Freestyle. Freestyle remains valid for ticket-local, implementation-only work.
- Do not bypass ai-spawn confirmation or MCP permission tiers.
- Do not introduce direct file-edit MCP tools for code changes.
- Do not require changes to specrails-core commands for the first implementation.
- Do not remove or rename existing `factory:openspec` behavior without compatibility.

## Decisions

### Decision 1: Add `factory:sdd-quick-openspec` as the product-facing built-in

Add a new factory loop id, `factory:sdd-quick-openspec`, with user-facing name `SDD Quick (OpenSpec)`. It maps to rail mode `loop` and uses the OpenSpec lifecycle graph.

Rationale:
- The name carries the intended policy: spec-driven, quick, OpenSpec-backed.
- Existing `factory:openspec` can remain as a compatibility alias or legacy entry. New operator guidance and UI copy should prefer `SDD Quick (OpenSpec)`.
- This avoids overloading Freestyle with contract-governed behavior.

Alternative considered: rename `factory:openspec` directly. Rejected because existing saved rails, tests, or external MCP clients may reference the old id.

### Decision 2: Reuse `opsxLifecycleGraph()` but add structured change targeting

The current OpenSpec lifecycle graph captures `{{run.changeId}}` after `opsx:ff` and then reuses it on later passes. That works when the first pass creates or clearly prints the change id. For SDD Quick, the common case may be "continue this existing OpenSpec change", so the target should not live only in prose.

The local ticket should carry optional metadata:

```json
{
  "openspecChangeName": "add-sdd-quick-openspec"
}
```

The loop interpolation layer should expose a safe token such as `{{spec.openspecChangeName}}` from ticket metadata, and the SDD Quick first step should instruct `opsx:ff` to continue that change when present. If absent, `opsx:ff` may create a new change from the ticket.

Rationale:
- The local ticket remains the operational wrapper.
- OpenSpec targeting becomes machine-readable.
- Relaunches and follow-ups do not depend on the agent restating the change id in free text.

Alternative considered: rely on ticket description text only. Rejected because it is fragile and makes the safest mode too dependent on prompt wording.

### Decision 3: Operator classification is policy, not another code-writing surface

The in-app operator should classify small work before launch:

- **Freestyle**: only when the change is ticket-local and implementation-only.
- **SDD Quick (OpenSpec)**: when OpenSpec artifacts exist or need to be amended for the requested change.
- **Implement/Batch**: when the change is broad, high-risk, multi-ticket, or better served by the full pipeline.

The operator still uses existing MCP actions: `specrails_specs`, `specrails_rails`, and `specrails_watch` when explicitly asked to wait.

Rationale:
- This is an orchestration policy on top of stable domain tools.
- It avoids a new "developer mode" that could write code outside Specrails' audit trail.

Alternative considered: add a new `specrails_develop` high-level MCP tool immediately. Deferred. It may be useful later, but the first version can be safer and smaller by encoding policy in the operator prompt plus first-class factory loop metadata.

### Decision 4: Freestyle must be OpenSpec-drift guarded

Freestyle should not be proposed when the operator identifies OpenSpec-governed work, unless the operator can explicitly classify the request as implementation-only within existing OpenSpec contracts.

Rationale:
- Freestyle can move fast, but its prompt is intentionally broad and autonomous.
- OpenSpec artifacts are stronger contracts than local ticket prose. If a change needs a contract update, the contract update must happen first.

Alternative considered: include OpenSpec context in every Freestyle run. Rejected as insufficient: context helps, but it does not enforce the rule that contracts must be amended before code changes.

## Risks / Trade-offs

- **[Risk] Existing OpenSpec lifecycle archives too aggressively for "quick" follow-ups.** -> Keep archive gated behind `opsx:verify` PASS and require the graph to fail clearly when no change id is captured.
- **[Risk] The operator may over-classify work as SDD Quick and make simple local edits feel heavy.** -> Prompt guidance must keep Freestyle available for implementation-only work and explain the reason when SDD Quick is chosen.
- **[Risk] Metadata token expansion leaks arbitrary metadata into prompts.** -> Expose only explicit, whitelisted fields such as `openspecChangeName`, not all ticket metadata.
- **[Risk] Backward compatibility with `factory:openspec`.** -> Keep the old id resolvable; add tests that both ids map to a valid loop graph.

## Migration Plan

1. Add the new factory loop entry while preserving existing ids.
2. Update loop/factory tests and any gallery ordering expectations.
3. Add whitelisted ticket metadata interpolation for `openspecChangeName`.
4. Update the operator prompt to describe Quick Develop strategy selection and the Freestyle/OpenSpec guardrail.
5. Validate launch through existing rail loop mode; no data migration required.

Rollback is straightforward: hide/remove the new factory entry and remove the operator guidance. Existing tickets and OpenSpec artifacts remain valid because no persisted schema migration is required.

## Open Questions

- Should `factory:openspec` remain visible as a separate legacy entry or become a hidden alias for `factory:sdd-quick-openspec`?
- Should SDD Quick default to Claude when the selected provider lacks native `/opsx:*` support, or rely on the existing fallback prompts for provider parity?
