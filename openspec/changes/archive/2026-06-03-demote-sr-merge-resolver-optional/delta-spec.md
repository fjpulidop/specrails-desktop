# Delta Spec: Demote sr-merge-resolver to Optional

This document specifies exactly what changes in each file, stated in normative terms. Implementors must not deviate from these precise edits.

---

## File 1: `client/src/components/AgentSelector.tsx`

### Change: Remove `sr-merge-resolver` from `CORE_AGENTS`

**Location:** The `CORE_AGENTS` constant, approximately line 36.

**Before:**
```ts
export const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
  'sr-merge-resolver',
])
```

**After:**
```ts
export const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
])
```

**Invariants this change must uphold:**
- `sr-merge-resolver` MUST remain in `ALL_AGENTS` with `category: 'Utilities'`.
- `DEFAULT_SELECTED` MUST NOT be edited; it is derived from `CORE_AGENTS` and will automatically reflect three agents.
- The `CORE_AGENTS` Set MUST contain exactly `sr-architect`, `sr-developer`, and `sr-reviewer` after this edit.

---

## File 2: `server/providers/claude-adapter.ts`

### Change: Remove `sr-merge-resolver` from `baselineAgents()`

**Location:** The `baselineAgents` property on the exported adapter object, approximately line 273.

**Before:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver'],
```

**After:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
```

**Invariants:**
- The return value MUST be exactly `['sr-architect', 'sr-developer', 'sr-reviewer']`.
- No other property on the claude adapter object is changed.

---

## File 3: `server/providers/codex-adapter.ts`

### Change: Remove `sr-merge-resolver` from `baselineAgents()`

**Location:** The `baselineAgents` property on the exported adapter object, approximately line 265.

**Before:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver'],
```

**After:**
```ts
baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
```

**Invariants:**
- The return value MUST be exactly `['sr-architect', 'sr-developer', 'sr-reviewer']`.
- This change MUST be identical in content to File 2. Both adapters must expose the same baseline trio.
- No other property on the codex adapter object is changed.

---

## File 4: `server/modules/agents/runtime/profiles-router.ts`

### Change A: Trim `baseline` array in `migrate-from-settings`

**Location:** Inside `router.post('/migrate-from-settings', ...)`, approximately line 95.

**Before:**
```ts
const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']
```

**After:**
```ts
const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer']
```

### Change B: Clear `pinnedLast` set and update comment

**Location:** Approximately lines 103–106, immediately after the `orderedAgents` declaration setup.

**Before:**
```ts
      // Order: baseline trio first (architect, developer, reviewer), optional
      // agents in the middle, sr-merge-resolver pinned last so rails' merge
      // phase runs after everything else.
      const pinnedLast = new Set(['sr-merge-resolver'])
```

**After:**
```ts
      // Order: baseline trio first (architect, developer, reviewer), optional
      // agents in the middle. sr-merge-resolver is no longer a baseline agent;
      // it sorts among optional agents alphabetically when present.
      const pinnedLast = new Set<string>()
```

**Invariants:**
- The three downstream filter calls that reference `pinnedLast` MUST NOT be changed; they operate correctly with an empty set.
- `required` field on profile agents: the existing expression `baseline.includes(a.id)` continues to determine `required`. After this change, `sr-merge-resolver` will have `required: false` in the migrated profile even when present in the project's agents directory. This is the intended behavior.
- No other route handlers in `profiles-router.ts` are modified.

---

## Summary Matrix

| File | Lines changed (approx) | Nature |
|---|---|---|
| `client/src/components/AgentSelector.tsx` | 1 line removed | Remove string from Set literal |
| `server/providers/claude-adapter.ts` | 1 line modified | Remove string from array literal |
| `server/providers/codex-adapter.ts` | 1 line modified | Remove string from array literal |
| `server/modules/agents/runtime/profiles-router.ts` | 2 lines modified + 1 comment updated | Remove string from array; empty Set |

**Total net diff:** approximately −4 lines across four files.

---

## What This Spec Does NOT Cover

The following are explicitly out of scope for this delta and must not be edited:

- `client/src/features/agents/components/ProfileEditor.tsx` pin-last UI behavior
- `server/modules/agents/runtime/profile-manager.ts` validation logic (it already delegates to adapters)
- `server/setup-manager.ts` (no hard-coded agent list present)
- `client/src/components/SetupWizard.tsx` (no edit needed; consumes `CORE_AGENTS` correctly)
- Any file in `specrails-core`
- Test files (tests do not assert on the size of `CORE_AGENTS` or `baselineAgents()` return value in a way that requires updates)
