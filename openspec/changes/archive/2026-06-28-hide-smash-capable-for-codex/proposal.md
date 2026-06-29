## Why

The Add Spec modal's Explore mode renders a SMASH-capable hint and the "enables SMASH" label on the Contract Layer checkbox regardless of the active project's provider. SMASH is a Claude-specific capability with no Codex equivalent; surfacing it for Codex projects misleads users and risks silent broken behaviour if a Codex project ends up with `contractRefine: true` in its explore scope.

## What Changes

- **`ContextScopeSlider`**: the `scope-smash-hint` block (`data-testid="scope-smash-hint"`) MUST NOT render when the active provider is `codex`. The block currently renders unconditionally when `value.contractRefine === true`.
- **`ContextScopeChecks`**: the Contract Layer checkbox's `hint` text currently reads `"post-commit refinement · enables SMASH"`. When provider is `codex`, the SMASH portion of the hint MUST be absent (rendered as `"post-commit refinement"` only).
- **`ProposeSpecModal`**: passes `provider` (already returned by `useDefaultSpecModel`) down to `ContextScopeSlider` and `ContextScopeChecks` so the guard is reactive on project switch without reopening the modal.
- **Server defence-in-depth**: `POST /:projectId/chat/conversations` strips `contextScope.contractRefine: true` to `false` when `project.provider === 'codex'`, ensuring a client bug cannot enable a Claude-only feature for Codex projects.

## Capabilities

### New Capabilities

- `provider-gated-smash-ui`: SMASH-capable UI elements in the Add Spec modal are gated by the active project's provider; absent entirely for Codex projects.

### Modified Capabilities

- `specs-smash`: SMASH action visibility gate now also requires `project.provider !== 'codex'` at the Add Spec entrypoint (the hint and Contract Layer SMASH mention). The existing `TicketDetailModal` SMASH button gating is unchanged by this change.
- `add-spec-context-scope`: the `ContextScopeSlider` and `ContextScopeChecks` components accept a new optional `provider` prop; the SMASH-related copy is hidden when `provider === 'codex'`.

## Impact

- `client/src/components/ContextScopeSlider.tsx` — new optional `provider` prop; hint rendered conditionally.
- `client/src/components/ContextScopeChecks.tsx` — new optional `provider` prop; checkbox hint text trimmed for Codex.
- `client/src/components/ProposeSpecModal.tsx` — destructures `provider` from `useDefaultSpecModel`; threads it to both scope components.
- `server/project-router.ts` — `POST /:projectId/chat/conversations` endpoint strips `contractRefine` from the scope when `project.provider === 'codex'`.
- Tests: `ContextScopeSlider.test.tsx`, `ContextScopeChecks.test.tsx`, `ProposeSpecModal.test.tsx`, `project-router.test.ts`.
