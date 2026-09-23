# Technical Design: Demote sr-merge-resolver to Optional

## Architecture Overview

This change has no schema migrations, no new modules, and no API surface changes. It is a set of four surgical edits to existing files, each removing a single string from a list that defines "mandatory" agents.

The dependency chain matters:

```
AgentSelector.CORE_AGENTS
    └── SetupWizard.handleInstall  (forces CORE_AGENTS into install payload)
        └── specrails-core init    (provisions agents based on selected list)

ProviderAdapter.baselineAgents()
    └── ProfileManager.validateProfile  (hard-fails if any baseline agent is missing)
        └── ProfilesRouter.migrate-from-settings  (seeds default profile)
```

The fix is upstream in both chains: removing `sr-merge-resolver` from `CORE_AGENTS` and from `baselineAgents()` propagates the change through every downstream consumer without requiring those consumers to change.

---

## Affected Files

### 1. `client/src/components/AgentSelector.tsx`

**What changes:** Remove `'sr-merge-resolver'` from the `CORE_AGENTS` Set.

**Current state:**
```ts
export const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
  'sr-merge-resolver',   // ← remove
])
```

**Target state:**
```ts
export const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
])
```

**Cascade effects within this file:**
- `DEFAULT_SELECTED` is derived as `new Set([...CORE_AGENTS])`, so it automatically shrinks to three agents. No explicit edit needed.
- `selectNone()` calls `onChange([...CORE_AGENTS])`, so "None" will now floor at three agents. Correct behavior.
- `toggle()` and `toggleCategory()` guard on `CORE_AGENTS.has(agentId)`. `sr-merge-resolver` becomes toggleable like any Utilities agent.
- The `AgentSelector` renders `sr-merge-resolver` without the `Lock` icon and without `isCore` styling, meaning it is visually deselectable.

**No change to `ALL_AGENTS`:** `sr-merge-resolver` remains in `ALL_AGENTS` with `category: 'Utilities'` so it continues to appear in the selector grid.

---

### 2. `server/providers/claude-adapter.ts`

**What changes:** Remove `'sr-merge-resolver'` from the `baselineAgents()` return value.

**Current state:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver'],
```

**Target state:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
```

**Cascade effects:**
- `ProfileManager.validateProfile` calls `adapter.baselineAgents()` and rejects profiles that are missing any returned id. After this change, a profile containing only `sr-architect`, `sr-developer`, `sr-reviewer` in `agents[]` passes validation. A profile that also includes `sr-merge-resolver` still passes (it is not excluded, merely no longer required).
- Existing profiles already containing `sr-merge-resolver` are unaffected — validation only checks for presence of baseline agents, not absence of non-baseline agents.

---

### 3. `server/providers/codex-adapter.ts`

**What changes:** Identical removal as `claude-adapter.ts`.

**Current state:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver'],
```

**Target state:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
```

Both adapters must be kept in sync because `ProfileManager` resolves the adapter from the project's provider field at runtime. A mismatch would allow claudeprojects to work correctly while codex projects still require `sr-merge-resolver` in the baseline.

---

### 4. `server/modules/agents/runtime/profiles-router.ts` — `migrate-from-settings` handler

**What changes:** The hard-coded `baseline` array and the comment above the ordering block.

**Current state:**
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
```

**Target state:**
```ts
const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer']
const missing = baseline.filter((id) => !agents.some((a) => a.id === id))
if (missing.length > 0) {
  res.status(400).json({
    error: `missing baseline agents in this project: ${missing.join(', ')}. Run 'npx specrails-core@latest update' first.`,
  })
  return
}
// Order: baseline trio first (architect, developer, reviewer), optional
// agents in the middle. sr-merge-resolver is no longer baseline; it
// sorts among optional agents when present.
const pinnedLast = new Set<string>()
```

**Rationale for keeping `pinnedLast` as an empty set rather than deleting it:** The downstream ordering pipeline (`orderedAgents`) already reads `pinnedLast` in two filter calls. Changing the value to an empty set is the smallest safe edit — no other lines need to change, and the three-way sort (baselineFirst / middle / pinnedLast) still produces a correct result with an empty pinnedLast set. A future change can remove the `pinnedLast` mechanism entirely if the product decides no agent should ever be pinned last.

**Behavior change:** Projects that do have `sr-merge-resolver.md` in `.claude/agents/` will still have it included in the migrated profile, but it will sort with the optional agents (alphabetically) rather than being pinned at the end. This is the intended behavior — it was only pinned because it was "mandatory last step"; if it is optional, no special ordering rule applies.

---

## What Does NOT Change

| Surface | Why untouched |
|---|---|
| `server/setup-manager.ts` | Does not contain a hard-coded agent list; reads the install-config.yaml written by the wizard, which is determined by `AgentSelector.CORE_AGENTS`. Fix flows through the client change. |
| `client/src/components/SetupWizard.tsx` | The `handleInstall` guard `[...new Set([...CORE_AGENTS, ...])]` is correct; it simply reads the updated `CORE_AGENTS`. No edit needed. |
| `client/src/features/agents/components/ProfileEditor.tsx` | The `sr-merge-resolver` pin-last behavior in the editor UI is a display convenience, not a data invariant. It does not affect what gets installed. Removing it is out of scope. |
| `server/modules/agents/runtime/profile-manager.ts` | Delegates to `adapter.baselineAgents()`; no hard-coded list to change. |
| `specrails-core` source | Explicitly out of scope. |
| Agent catalog listing | `sr-merge-resolver` remains in `ALL_AGENTS` and will appear in the catalog. |

---

## Data Shapes

### install-config.yaml (before this change)

```yaml
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver]
  excluded: [sr-frontend-developer, sr-backend-developer, ...]
```

### install-config.yaml (after this change, default wizard run)

```yaml
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer]
  excluded: [sr-frontend-developer, sr-backend-developer, sr-merge-resolver, ...]
```

`sr-merge-resolver` moves from `selected` to `excluded` in the default wizard flow. A user who explicitly ticks the agent in the wizard UI will still have it in `selected`.

### ProfileManager baseline validation (after this change)

```ts
// Passes:  agents = ['sr-architect', 'sr-developer', 'sr-reviewer']
// Passes:  agents = ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']
// Fails:   agents = ['sr-architect', 'sr-developer']   // missing sr-reviewer
```

---

## Risk Assessment

**Risk: Existing profiles in the wild require sr-merge-resolver**

Mitigation: `ProfileManager` validation only checks that baseline agents are present; it does not check that non-baseline agents are absent. Existing profiles with `sr-merge-resolver` in `agents[]` continue to pass validation unchanged.

**Risk: migrate-from-settings called on a project that has sr-merge-resolver.md**

Mitigation: The endpoint reads `.claude/agents/` and builds a profile from whatever is present. If `sr-merge-resolver.md` exists, it is still included in `profile.agents[]`. The only change is that its absence no longer blocks the migration.

**Risk: tests that assert CORE_AGENTS has four members**

The `AgentSelector.test.tsx` file uses `CORE_IDS = [...CORE_AGENTS]` but never asserts on its exact length — it only uses it as a floor value for "None" assertions. The tests will continue to pass with a three-element `CORE_AGENTS`.

The `ProfileEditor.test.tsx` file at line 18 uses `{ id: 'sr-merge-resolver', required: true }` inside a test fixture for the editor component. This test constructs a profile object directly; it does not go through `baselineAgents()` or `CORE_AGENTS`, so it is unaffected.
