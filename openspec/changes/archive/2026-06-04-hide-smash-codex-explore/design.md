# Design: Hide SMASH-capable option in Explore mode for Codex projects

## Context

### Where the SMASH-capable element lives

`ContextScopeSlider` (`client/src/features/chat/components/ContextScopeSlider.tsx`) renders a
hint block when `value.contractRefine === true`:

```tsx
{value.contractRefine && (
  <div
    className="flex items-start gap-1.5 rounded-md border border-accent-highlight/40 bg-accent-highlight/10 px-2 py-1.5 text-[10px] text-foreground/80"
    data-testid="scope-smash-hint"
  >
    <span aria-hidden className="text-accent-highlight">⊢→</span>
    <span>
      <strong className="text-accent-highlight">SMASH-capable</strong> · Contract Layer is on,
      so this spec can later be decomposed into Sub-Specs.
    </span>
  </div>
)}
```

This component is used in `ProposeSpecModal` for both Quick and Explore modes.
The change only concerns the Explore mode (the hint is already innocuous for
Quick mode on Codex since `contractRefine` is managed separately there). However,
the guard must be applied at the `ContextScopeSlider` level because that is the
single place the element is rendered, and it serves both modes through the same
code path.

### How provider is resolved on the client

`ProposeSpecModal` uses `useDefaultSpecModel(activeProjectId, open)` from
`client/src/features/specs/components/explore-spec/SpecModelPicker.tsx`. This hook fetches
`GET /api/projects/:projectId/default-spec-model` and returns:

```ts
{ model, setModel, allowed, provider, loading, error }
```

The `provider` field (`'claude' | 'codex' | null`) is already resolved from the
server; `ProposeSpecModal` currently destructures only `{ model, setModel, allowed,
loading: modelLoading }` — the `provider` field goes unused. This change consumes
it.

### Server-side Explore conversation creation

`POST /chat/conversations` (`server/project-router.ts`, line 1084) already reads
`project.provider` when validating the model:

```ts
const provider: SpecProvider = (project.provider ?? 'claude') as SpecProvider
```

The `contextScope` parsed from `req.body.contextScope` is stored verbatim on the
conversation row. The defence-in-depth adds a provider check before normalising
the scope: if `provider !== 'claude'`, force `contractRefine: false` regardless
of what the client sent.

---

## Decision Record

### D1 — Single utility module for provider capability queries

**Decision**: Create `client/src/features/providers/lib/provider-capabilities.ts` with an
`isSmashCapable(provider: string): boolean` function.

**Rationale**: Capability checks scattered across components create invisible
coupling between provider semantics and UI code. A dedicated utility file
establishes a single source of truth that is trivially testable and easy to
extend when a third provider is added. The function is a pure predicate — no
React hooks, no side effects — making it usable in both component render trees
and test assertions without a provider wrapper.

**Alternative rejected**: Inline `activeProject?.provider === 'claude'` directly
in `ContextScopeSlider`. Rejected because (a) `ContextScopeSlider` is a
presentational component that should not know about provider semantics, and (b)
duplicating the condition across components as the capability set grows is a
maintenance hazard.

### D2 — Pass capability as a prop to ContextScopeSlider

**Decision**: Add `smashCapable?: boolean` (default `true`) to
`ContextScopeSliderProps`. `ProposeSpecModal` derives the value from
`isSmashCapable(provider)` and passes it through.

**Rationale**: `ContextScopeSlider` is a controlled, reusable component. Pulling
`useHub` or `useDefaultSpecModel` into it would couple a presentational widget to
global context and break any usage of the slider outside the hub context (e.g.,
Storybook, unit tests). A prop keeps the component pure and the dependency graph
clean.

**Alternative rejected**: Read provider directly inside `ContextScopeSlider` via
`useHub`. Rejected because it violates the client convention that hooks pulling
from Hub context belong in page-level components, not in shared UI primitives.

### D3 — Server strips contractRefine at conversation creation, not at downstream spawn

**Decision**: Strip `contractRefine: true` from the `contextScope` inside
`POST /chat/conversations` when `project.provider !== 'claude'`.

**Rationale**: The conversation row's `context_scope` column is the durable
record consumed by Contract Refine Runner, analytics, and any future SMASH
trigger. Stripping at creation time means all downstream code that reads the
stored scope sees the correct value — no need for additional guards in the refine
runner or smash eligibility check. Stripping only at spawn time (e.g., in
ChatManager) would leave incorrect data in the conversation row.

---

## File-by-File Changes

### `client/src/features/providers/lib/provider-capabilities.ts` — CREATE

New pure utility module. Contains one exported function and one exported type:

```ts
export type ProviderId = 'claude' | 'codex'

/**
 * Returns true when the given provider supports SMASH (Spec decomposition).
 * SMASH requires a Contract Layer that is only generated for Claude projects.
 */
export function isSmashCapable(provider: string | null | undefined): boolean {
  return provider === 'claude'
}
```

The function accepts `string | null | undefined` rather than a strict union so
callers need not assert type narrowness when the provider hasn't been resolved yet
(null/undefined from `useDefaultSpecModel` before the fetch completes returns
`false`, which is the safe default — better to hide the hint momentarily than to
flash it for Codex users during load).

### `client/src/features/chat/components/ContextScopeSlider.tsx` — MODIFY

Extend `ContextScopeSliderProps` with:

```ts
/** When false, the SMASH-capable hint is not rendered even if contractRefine is
 *  on. Defaults to true for backward compatibility. */
smashCapable?: boolean
```

Destructure in the function signature with default `true`:

```ts
export function ContextScopeSlider({
  value,
  onChange,
  budget = null,
  budgetError = false,
  model = 'sonnet',
  maxPresetId = 'hub',
  onPresetChange,
  smashCapable = true,
}: ContextScopeSliderProps) {
```

Update the hint render condition:

```tsx
{value.contractRefine && smashCapable && (
  <div
    className="flex items-start gap-1.5 rounded-md border ..."
    data-testid="scope-smash-hint"
  >
    ...
  </div>
)}
```

No other logic changes. Default `true` means all existing call sites continue to
render the hint without modification unless they opt out.

### `client/src/features/specs/components/ProposeSpecModal.tsx` — MODIFY

1. Import `isSmashCapable` from the new utility module.
2. Destructure `provider` from `useDefaultSpecModel`:

```ts
const { model, setModel, allowed, loading: modelLoading, provider } =
  useDefaultSpecModel(activeProjectId, open)
```

3. Derive the capability once (recomputed on every render so a project switch
   mid-modal reflects immediately):

```ts
const smashCapable = isSmashCapable(provider)
```

4. Pass `smashCapable` to `ContextScopeSlider`:

```tsx
<ContextScopeSlider
  value={scope}
  onChange={handleScopeChange}
  budget={budget}
  budgetError={budgetError}
  model={model ?? 'sonnet'}
  maxPresetId={mode === 'quick' ? 'max' : 'hub'}
  smashCapable={smashCapable}
/>
```

The `provider` value from `useDefaultSpecModel` is `null` while the fetch is
in-flight. `isSmashCapable(null)` returns `false`, so during loading the hint
is hidden. Once resolved, if the project is Claude, the hint appears; if Codex,
it stays hidden. This matches the requirement that switching projects
(triggering a re-fetch via `open` dependency) hides the hint reactively.

### `server/project-router.ts` — MODIFY

Inside `router.post('/:projectId/chat/conversations', ...)`, after parsing
`provider` (line 1086) and before `normalizeContextScope` is called:

```ts
// Defence-in-depth: SMASH is Claude-only. Strip contractRefine from the scope
// if the project is not using Claude, so no downstream code (Contract Refine
// Runner, SMASH eligibility) sees a mismatched flag.
const safeRawScope =
  provider !== 'claude' && rawScope != null
    ? { ...rawScope, contractRefine: false }
    : rawScope
// Replace the existing `normalizeContextScope(rawScope ?? fallback, fallback)`
// call with:
scope = normalizeContextScope(safeRawScope ?? fallback, fallback)
```

The change is two lines: one to compute `safeRawScope`, one to swap the argument.
No new imports required — `provider` and `rawScope` are already in scope at that
point in the handler.

---

## Component Interaction Diagram

```
ProposeSpecModal
  ├─ useDefaultSpecModel(activeProjectId, open)
  │    └─ returns { model, setModel, allowed, provider, loading }
  ├─ isSmashCapable(provider)         ← new call
  │    └─ returns boolean
  └─ ContextScopeSlider
       ├─ props: { value, onChange, ..., smashCapable }   ← new prop
       └─ renders scope-smash-hint only when
            value.contractRefine && smashCapable
```

---

## Invariants to Preserve

1. `isSmashCapable(provider)` returns `true` iff `provider === 'claude'`.
2. The `scope-smash-hint` element is not in the DOM when `smashCapable` is false,
   regardless of `value.contractRefine`.
3. All existing call sites of `ContextScopeSlider` that do not pass `smashCapable`
   continue to behave exactly as before (default `true`).
4. The server stores `contractRefine: false` on the conversation row for any
   Codex Explore conversation, even if the client sends `contractRefine: true`.
5. No layout shift occurs when `smashCapable` changes value — the hint block
   collapsing is already gated by `value.contractRefine` so it only renders
   in a non-zero-height state today; removing the condition adds no new reflow.

---

## Compatibility

No breaking changes to any public API, CLI flag, or WebSocket event contract.
The `smashCapable` prop is additive with a backward-compatible default. The
server-side change strips a field from an internal normalisation step that was
previously a no-op for Codex.
