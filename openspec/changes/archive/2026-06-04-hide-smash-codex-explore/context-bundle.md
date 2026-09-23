# Context Bundle: Hide SMASH-capable option in Explore mode for Codex projects

## Exact Changes

### Task 1.1 — Create `client/src/features/providers/lib/provider-capabilities.ts`

Create this file in its entirety:

```ts
/**
 * Provider capability guards.
 *
 * Pure functions with no side effects — safe to call from any render context
 * or test without a React provider wrapper.
 *
 * See openspec/changes/hide-smash-codex-explore.
 */

export type ProviderId = 'claude' | 'codex'

/**
 * Returns true when the given provider supports SMASH (Spec decomposition via
 * Contract Layer). SMASH requires a Claude-specific Contract Layer generation
 * step; no Codex equivalent exists.
 *
 * Accepts `string | null | undefined` so callers need not assert type narrowness
 * when the provider has not yet been resolved (null/undefined → false, which is
 * the safe default: hide the hint rather than flash it for Codex users).
 */
export function isSmashCapable(provider: string | null | undefined): boolean {
  return provider === 'claude'
}
```

### Task 2.1 — Extend `ContextScopeSliderProps` in `ContextScopeSlider.tsx`

Location: `client/src/features/chat/components/ContextScopeSlider.tsx`, interface at line 99
and function signature at line 120.

**Before (interface):**
```ts
interface ContextScopeSliderProps {
  value: ContextScope
  onChange: (next: ContextScope) => void
  budget?: ContextBudget | null
  budgetError?: boolean
  model?: string
  maxPresetId?: Preset['id']
  /** Optional callback to expose the active preset id (or 'custom') to the parent. */
  onPresetChange?: (presetId: Preset['id'] | 'custom') => void
}
```

**After (interface):**
```ts
interface ContextScopeSliderProps {
  value: ContextScope
  onChange: (next: ContextScope) => void
  budget?: ContextBudget | null
  budgetError?: boolean
  model?: string
  maxPresetId?: Preset['id']
  /** Optional callback to expose the active preset id (or 'custom') to the parent. */
  onPresetChange?: (presetId: Preset['id'] | 'custom') => void
  /** When false, the SMASH-capable hint is not rendered even if contractRefine is
   *  on. Defaults to true for backward compatibility with all existing call sites. */
  smashCapable?: boolean
}
```

**Before (function signature destructuring):**
```ts
export function ContextScopeSlider({
  value,
  onChange,
  budget = null,
  budgetError = false,
  model = 'sonnet',
  maxPresetId = 'hub',
  onPresetChange,
}: ContextScopeSliderProps) {
```

**After (function signature destructuring):**
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

**Before (hint render, around line 285):**
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

**After (hint render):**
```tsx
{value.contractRefine && smashCapable && (
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

The only diff is `&& smashCapable` added to the condition. No other lines change.

### Task 2.2 — Update `ProposeSpecModal.tsx`

**Add import** after the existing imports from `'../hooks/useContextScope'`:

```ts
import { isSmashCapable } from '../lib/provider-capabilities'
```

**Before (useDefaultSpecModel destructure, line 69):**
```ts
const { model, setModel, allowed, loading: modelLoading } = useDefaultSpecModel(activeProjectId, open)
```

**After:**
```ts
const { model, setModel, allowed, loading: modelLoading, provider } = useDefaultSpecModel(activeProjectId, open)
```

**Add after the `tier` useMemo** (around line 74):
```ts
const smashCapable = isSmashCapable(provider)
```

**Before (ContextScopeSlider JSX, around line 233):**
```tsx
<ContextScopeSlider
  value={scope}
  onChange={handleScopeChange}
  budget={budget}
  budgetError={budgetError}
  model={model ?? 'sonnet'}
  maxPresetId={mode === 'quick' ? 'max' : 'hub'}
/>
```

**After:**
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

### Task 3.1 — Server defence-in-depth in `server/project-router.ts`

Location: inside `router.post('/:projectId/chat/conversations', ...)`, around
line 1103. `provider` is already in scope (set at line 1086).

**Before:**
```ts
const rawScope = req.body?.contextScope
if (rawScope !== undefined && kind !== 'explore') {
  res.status(400).json({ error: 'contextScope is only allowed for kind=explore' })
  return
}
let scope: ContextScope | undefined
if (kind === 'explore') {
  const fallback = getLastContextScope(db, 'explore')
  scope = normalizeContextScope(rawScope ?? fallback, fallback)
  setLastContextScope(db, scope)
  console.log(`[project-router] new explore conv ${id} scope=${JSON.stringify(scope)} rawScope=${JSON.stringify(rawScope)}`)
}
```

**After:**
```ts
const rawScope = req.body?.contextScope
if (rawScope !== undefined && kind !== 'explore') {
  res.status(400).json({ error: 'contextScope is only allowed for kind=explore' })
  return
}
let scope: ContextScope | undefined
if (kind === 'explore') {
  const fallback = getLastContextScope(db, 'explore')
  // Defence-in-depth: SMASH is Claude-only. Strip contractRefine from the scope
  // when the project uses a non-Claude provider so no downstream code (Contract
  // Refine Runner, SMASH eligibility) sees a mismatched flag.
  const safeRawScope =
    provider !== 'claude' && rawScope != null
      ? { ...rawScope, contractRefine: false }
      : rawScope
  scope = normalizeContextScope(safeRawScope ?? fallback, fallback)
  setLastContextScope(db, scope)
  console.log(`[project-router] new explore conv ${id} scope=${JSON.stringify(scope)} rawScope=${JSON.stringify(rawScope)}`)
}
```

Two lines added: the comment block and the `safeRawScope` computation.
`rawScope` → `safeRawScope` in the `normalizeContextScope` call. No other
changes in the handler.

---

## Relevant Existing Code Patterns

### How `provider` flows from server to client model picker

`GET /api/projects/:projectId/default-spec-model` (project-router.ts, line 477):
```ts
router.get('/:projectId/default-spec-model', (req: Request, res: Response) => {
  const { project } = ctx(req)
  const provider: SpecProvider = (project.provider ?? 'claude') as SpecProvider
  const model = resolveDefaultSpecModel({ projectPath: project.path, provider })
  const allowed = getModelsForProvider(provider)
  res.json({ model, provider, allowed })
})
```

`useDefaultSpecModel` hook (`SpecModelPicker.tsx`) already stores and returns
`provider` — it is authoritative on the client side. The `ProposeSpecModal` just
needs to consume it.

### How ContextScopeSlider is currently called in ProposeSpecModal

```tsx
<ContextScopeSlider
  value={scope}
  onChange={handleScopeChange}
  budget={budget}
  budgetError={budgetError}
  model={model ?? 'sonnet'}
  maxPresetId={mode === 'quick' ? 'max' : 'hub'}
/>
```

No other callers in the codebase pass `smashCapable`, so the default `true`
preserves all existing behaviour.

### Existing `provider` usage in project-router conversation handler

The `provider` local variable is already declared at line 1086 and used for model
validation (lines 1091–1098). The new `safeRawScope` logic inserts cleanly after
`rawScope` is declared and before the `if (kind === 'explore')` block.

### ContextScope type definition

`client/src/features/chat/types/context-scope.ts` defines:
```ts
export interface ContextScope {
  specrails: boolean
  openspec: boolean
  full: boolean
  mcp: boolean
  contractRefine: boolean
}
```

The `safeRawScope` spread `{ ...rawScope, contractRefine: false }` is type-safe
because `rawScope` at that point is the raw JSON body field (typed `unknown` or
`object`) — `normalizeContextScope` handles the type narrowing downstream.

---

## Invariants to Preserve

1. `isSmashCapable('claude')` === `true`; any other input === `false`.
2. `ContextScopeSlider` with `smashCapable` omitted behaves identically to the
   current code (the prop defaults to `true`).
3. `data-testid="scope-smash-hint"` is NOT in the DOM when `smashCapable={false}`.
4. The server stores `contractRefine: false` in `context_scope` for any Codex
   Explore conversation, even when the client sends `contractRefine: true`.
5. The `provider` value from `useDefaultSpecModel` is `null` while fetching;
   `isSmashCapable(null)` returns `false` — safe default during loading.
6. Switching the active project triggers a re-fetch via `useDefaultSpecModel`
   (which depends on `activeProjectId` and `open`), so `provider` updates
   reactively and `smashCapable` re-evaluates without modal close/reopen.
7. No layout shift occurs when `smashCapable` flips — the hint block is already
   conditionally mounted today; removing it adds no new reflow.
