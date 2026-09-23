# Context Bundle: Demote sr-merge-resolver to Optional

This file contains the key code patterns and existing conventions an implementor needs to understand before making the edits. All excerpts are taken directly from the current codebase.

---

## 1. `CORE_AGENTS` and `DEFAULT_SELECTED` in AgentSelector

**File:** `client/src/components/AgentSelector.tsx`

```ts
// Core agents cannot be deselected — the implementation pipeline depends on them
export const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
  'sr-merge-resolver',   // ← this is what we remove
])

// Default selection: core agents only
export const DEFAULT_SELECTED = new Set([...CORE_AGENTS])
```

`DEFAULT_SELECTED` is derived: it re-spreads `CORE_AGENTS`. After removing `sr-merge-resolver` from `CORE_AGENTS`, `DEFAULT_SELECTED` automatically contains only three agents — no direct edit to `DEFAULT_SELECTED` is needed.

The `toggle()` function guards on `CORE_AGENTS`:
```ts
function toggle(agentId: string) {
  if (CORE_AGENTS.has(agentId)) return  // core agents cannot be toggled
  ...
}
```

The `selectNone()` function floors at `CORE_AGENTS`:
```ts
function selectNone() {
  onChange([...CORE_AGENTS])  // core agents always stay selected
}
```

Both will behave correctly with a three-element `CORE_AGENTS`.

---

## 2. How SetupWizard builds the install payload

**File:** `client/src/components/SetupWizard.tsx` (lines ~615–618)

```ts
// Ensure core agents are always included
const selectedWithCore = [...new Set([...CORE_AGENTS, ...cfg.selectedAgents])]
const excluded = ALL_AGENTS.map((a) => a.id).filter((id) => !selectedWithCore.includes(id))
```

This reads `CORE_AGENTS` at call time — no caching. After Task 1 removes `sr-merge-resolver` from `CORE_AGENTS`, the `selectedWithCore` union no longer includes it unless the user explicitly selected it in the wizard. `excluded` is computed as the complement of `selectedWithCore`, so `sr-merge-resolver` will appear in `excluded` on a default install. No edit to `SetupWizard.tsx` is required.

---

## 3. `baselineAgents()` in both provider adapters

**File:** `server/providers/claude-adapter.ts` (line ~273)

```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver'],
```

**File:** `server/providers/codex-adapter.ts` (line ~265)

```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver'],
```

Both are simple arrow functions returning a string array. The `ProviderAdapter` interface in `server/providers/types.ts` declares the method signature; the return type is `string[]`, so removing one element is type-safe.

---

## 4. How ProfileManager uses `baselineAgents()`

**File:** `server/modules/agents/runtime/profile-manager.ts` (lines ~134–147)

```ts
const baseline = adapter.baselineAgents()
// ...
// pipeline depends on the baseline agents existing in the chain. The set is
// adapter-driven so future providers can declare their own baseline.
const missing = baseline.filter((id) => !agentIds.has(id))
if (missing.length) {
  throw new ProfileValidationError(
    `profile must include baseline agents for provider '${providerId}': missing ${missing.join(', ')}`
  )
}
```

`ProfileManager` does not hard-code any agent ids — it delegates entirely to `adapter.baselineAgents()`. The fix in the adapter propagates through automatically.

---

## 5. Hard-coded baseline in `migrate-from-settings`

**File:** `server/modules/agents/runtime/profiles-router.ts` (lines ~65–130)

This is the one server-side location that does NOT use `adapter.baselineAgents()`. It is a standalone legacy migration endpoint that seeds a `default` profile from existing agent frontmatters on disk.

```ts
const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']
const missing = baseline.filter((id) => !agents.some((a) => a.id === id))
if (missing.length > 0) {
  res.status(400).json({
    error: `missing baseline agents in this project: ${missing.join(', ')}. Run 'npx specrails-core@latest update' first.`,
  })
  return
}
// Order: baseline trio first (architect, developer, reviewer), optional
// agents in the middle, sr-merge-resolver pinned last so rails' merge
// phase runs after everything else.
const pinnedLast = new Set(['sr-merge-resolver'])
const baselineFirst = new Set(['sr-architect', 'sr-developer', 'sr-reviewer'])
const orderedAgents = [
  ...agents.filter((a) => baselineFirst.has(a.id))
    .sort((a, b) => {
      const rank = ['sr-architect', 'sr-developer', 'sr-reviewer']
      return rank.indexOf(a.id) - rank.indexOf(b.id)
    }),
  ...agents.filter((a) => !baselineFirst.has(a.id) && !pinnedLast.has(a.id))
    .sort((a, b) => a.id.localeCompare(b.id)),
  ...agents.filter((a) => pinnedLast.has(a.id)),
]
// Build the default profile mirroring legacy routing.
const profile = {
  ...
  agents: orderedAgents.map((a) => ({
    id: a.id,
    model: a.model,
    required: baseline.includes(a.id),  // ← required=false for non-baseline agents
  })),
  ...
}
```

Key observation: `required: baseline.includes(a.id)` — after removing `sr-merge-resolver` from `baseline`, `required` will be `false` for that agent in the migrated profile. This is correct behavior.

The `pinnedLast` mechanics: the three `agents.filter(...)` calls below the `pinnedLast` declaration will all work correctly when `pinnedLast` is `new Set<string>()` (empty). The third filter produces zero results, and the middle filter includes `sr-merge-resolver` (when present) in the alphabetical optional section.

---

## 6. Existing test coverage

**File:** `client/src/components/__tests__/AgentSelector.test.tsx`

```ts
const CORE_IDS = [...CORE_AGENTS]   // derived at test module load time

it('None button keeps only core agents selected', () => {
  const onChange = vi.fn()
  render(<AgentSelector selected={ALL_IDS} onChange={onChange} />)
  fireEvent.click(screen.getByText('None'))
  const result = onChange.mock.calls[0][0] as string[]
  expect(result).toEqual(expect.arrayContaining(CORE_IDS))
  expect(result.length).toBe(CORE_IDS.length)
})
```

`CORE_IDS` is derived from the live export, not hard-coded. When `CORE_AGENTS` shrinks to three, `CORE_IDS` becomes three elements and `result.length` is asserted to be three. The test passes without modification.

**File:** `client/src/features/agents/components/__tests__/ProfileEditor.test.tsx` (line 18)

```ts
{ id: 'sr-merge-resolver', required: true },
```

This is a test fixture that directly constructs a profile object for the `ProfileEditor` component. It does not go through `baselineAgents()`, `CORE_AGENTS`, or any of the modified files. It is unaffected by this change.

---

## 7. Install config YAML shape (for reference)

The YAML written by the wizard to `.specrails/install-config.yaml` and passed to `specrails-core init --from-config`:

```yaml
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer]
  excluded: [sr-frontend-developer, sr-backend-developer, sr-frontend-reviewer,
             sr-backend-reviewer, sr-security-reviewer, sr-performance-reviewer,
             sr-product-manager, sr-product-analyst, sr-test-writer,
             sr-doc-sync, sr-merge-resolver]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
agent_teams: false
```

`specrails-core` provisions agents based on the `selected` list. Moving `sr-merge-resolver` to `excluded` is sufficient to prevent its `.md` file from being placed in `.claude/agents/`.
