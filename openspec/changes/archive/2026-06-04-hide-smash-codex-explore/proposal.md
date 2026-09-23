# Proposal: Hide SMASH-capable option in Explore mode for Codex projects

## Problem

The Add Spec modal's Explore mode renders a **SMASH-capable** hint inside
`ContextScopeSlider` whenever `contextScope.contractRefine === true`. This hint
is surfaced regardless of the active project's AI provider. SMASH
(Spec-to-Multi-Aspect-Sub-Specs Hierarchical decomposition) is a capability that
depends on the Claude-specific Contract Layer flow. Codex projects have no
equivalent: the `contractRefine` option in a Codex Explore conversation produces
no Contract Layer, and the SMASH decomposition endpoint (`POST /tickets/:id/smash`)
spawns a Claude agent — both operations are meaningless for Codex projects.

Showing the SMASH-capable label to Codex users is misleading and may encourage
selecting `contractRefine: true` expecting future decomposability that will never
materialise. If a Codex Explore session were committed with `contractRefine: true`
in the payload, the server would attempt a Contract Refine run that is not
designed for Codex, wasting tokens and possibly storing a malformed Contract Layer
section.

## Proposed Solution

Gate the SMASH-capable UI element in `ContextScopeSlider` on the active project's
resolved provider. When `project.provider === 'codex'`, the element must not be
rendered at all — no greying out, no tooltip, full DOM removal.

The guard is implemented via a new pure utility `isSmashCapable(provider: string)`,
co-located in `client/src/features/providers/lib/provider-capabilities.ts`, which returns `true` iff
`provider === 'claude'`. `ProposeSpecModal` already consumes `useDefaultSpecModel`
which returns the `provider` field alongside the model list; the modal passes a new
`smashCapable` prop (or equivalent boolean) down to `ContextScopeSlider`.

As defence-in-depth, the server strips `contractRefine: true` from the `contextScope`
on `POST /chat/conversations` when `project.provider !== 'claude'`, preventing a
mismatch between client guard and server behaviour if the client ever sends a stale
or malformed payload.

## Acceptance Criteria

- On a Codex project, opening Add Spec → Explore mode does **not** render the
  SMASH-capable element (the element is absent from the DOM, not hidden).
- On a Claude project, the SMASH-capable element renders as before.
- Switching the active project from Claude to Codex without reopening the modal
  also hides the element reactively (the guard re-evaluates from context on every
  render, not just on modal open).
- Server strips `contractRefine: true` from the Explore `contextScope` payload
  when `project.provider !== 'claude'`.
- No console errors or layout shift when the element is absent.
- TypeScript strict mode passes (`cd client && npx tsc --noEmit`).
- All existing tests pass and coverage thresholds are maintained.

## Non-Goals

- Changing SMASH behaviour or eligibility for Claude projects.
- Modifying the Quick mode flow in any way.
- Disabling or greying out the SMASH-capable option (full removal only).
- Preventing `contractRefine` selection entirely for Codex (the flag still
  enables Contract Layer text enrichment if that ever gains Codex support; only
  the downstream SMASH eligibility hint is gated).
