# Tasks: Demote sr-merge-resolver to Optional

Tasks are ordered by dependency. All tasks are independent of each other and can be executed in any order or in parallel; there are no cross-task data dependencies in this change.

---

## Task 1 — Remove sr-merge-resolver from client CORE_AGENTS

**Layer:** `[frontend]`

**Description:**
Edit `AgentSelector.tsx` to remove `'sr-merge-resolver'` from the `CORE_AGENTS` Set. This is the root client-side change: `DEFAULT_SELECTED`, `SetupWizard.handleInstall`, and the lock-icon rendering all derive from `CORE_AGENTS`, so they automatically reflect the trimmed trio without further edits.

**Files:**

- Modify: `client/src/components/AgentSelector.tsx`

**Exact change:**
Remove the line `'sr-merge-resolver',` from the `CORE_AGENTS` Set literal. Do not touch `ALL_AGENTS`, `DEFAULT_SELECTED`, or any other export.

**Acceptance Criteria:**
- `CORE_AGENTS` contains exactly `sr-architect`, `sr-developer`, `sr-reviewer`.
- `sr-merge-resolver` still appears in `ALL_AGENTS` under category `Utilities`.
- `DEFAULT_SELECTED` (derived) contains exactly three agents.
- Running `cd client && npx tsc --noEmit` reports no type errors.
- Existing `AgentSelector.test.tsx` tests all pass without modification.

---

## Task 2 — Remove sr-merge-resolver from claude-adapter baselineAgents

**Layer:** `[backend]`

**Description:**
Edit `claude-adapter.ts` to trim `baselineAgents()` to the three-element core trio. After this change, `ProfileManager` will accept profiles that contain only `sr-architect`, `sr-developer`, `sr-reviewer` without requiring `sr-merge-resolver`.

**Files:**

- Modify: `server/providers/claude-adapter.ts`

**Exact change:**
Remove `'sr-merge-resolver'` from the array returned by `baselineAgents`. The resulting return value must be `['sr-architect', 'sr-developer', 'sr-reviewer']`.

**Acceptance Criteria:**
- `baselineAgents()` returns `['sr-architect', 'sr-developer', 'sr-reviewer']`.
- `ProfileManager` validation passes a profile with only the three core agent ids.
- `ProfileManager` validation still fails a profile missing `sr-reviewer`.
- `npm run typecheck` reports no errors.

---

## Task 3 — Remove sr-merge-resolver from codex-adapter baselineAgents

**Layer:** `[backend]`

**Description:**
Make the identical change to `codex-adapter.ts` as Task 2. Both provider adapters must stay in sync so that the wizard behavior and profile validation are consistent regardless of which provider a project uses.

**Files:**

- Modify: `server/providers/codex-adapter.ts`

**Exact change:**
Remove `'sr-merge-resolver'` from the array returned by `baselineAgents`. The resulting return value must be `['sr-architect', 'sr-developer', 'sr-reviewer']`.

**Acceptance Criteria:**
- `baselineAgents()` in `codex-adapter.ts` returns the same value as in `claude-adapter.ts`: `['sr-architect', 'sr-developer', 'sr-reviewer']`.
- `npm run typecheck` reports no errors.

---

## Task 4 — Update migrate-from-settings baseline and ordering in profiles-router

**Layer:** `[backend]`

**Description:**
Edit the `migrate-from-settings` POST handler in `profiles-router.ts` to remove `sr-merge-resolver` from the hard-coded `baseline` array and clear the `pinnedLast` Set. This aligns the legacy migration path with the new install behavior — `sr-merge-resolver` is included in the seeded profile if present on disk, but it is no longer a required baseline agent and is no longer pinned to the end of the agent ordering.

**Files:**

- Modify: `server/modules/agents/runtime/profiles-router.ts`

**Exact changes (two edits in the same handler):**

1. Change the `baseline` constant from four elements to three:
   ```ts
   const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer']
   ```

2. Clear `pinnedLast` and update its comment:
   ```ts
   // Order: baseline trio first (architect, developer, reviewer), optional
   // agents in the middle. sr-merge-resolver is no longer a baseline agent;
   // it sorts among optional agents alphabetically when present.
   const pinnedLast = new Set<string>()
   ```

Do not change the three downstream filter calls that reference `pinnedLast` — they operate correctly with an empty set.

**Acceptance Criteria:**
- `POST /profiles/migrate-from-settings` on a project that has `sr-architect.md`, `sr-developer.md`, `sr-reviewer.md` (but NOT `sr-merge-resolver.md`) returns 201 with a valid profile.
- `POST /profiles/migrate-from-settings` on a project that also has `sr-merge-resolver.md` returns 201 and includes `sr-merge-resolver` in `profile.agents[]` with `required: false`.
- `POST /profiles/migrate-from-settings` on a project missing `sr-reviewer.md` still returns 400.
- `npm run typecheck` reports no errors.

---

## Task 5 — Verify end-to-end wizard install flow and run test suite

**Layer:** `[backend]` `[frontend]`

**Description:**
After Tasks 1–4 are complete, verify that the full change coheres: run the type-checker and test suite, confirm no regressions in `AgentSelector.test.tsx` or `ProfileEditor.test.tsx`, and confirm the acceptance criteria from the ticket are met conceptually (installation produces only the trio).

**Files:**

No files modified. This is a verification task.

**Steps:**
1. `npm run typecheck` — must pass with zero errors.
2. `npm test` — all server and CLI tests must pass.
3. `cd client && npm run test:coverage` — client tests must pass; existing `AgentSelector` tests must pass without modification.
4. Manually confirm: `CORE_AGENTS` has three members, both `baselineAgents()` implementations return three-element arrays, and `profiles-router.ts` `baseline` is three elements.

**Acceptance Criteria:**
- Zero type errors.
- Zero test failures.
- `CORE_AGENTS.size === 3` (verifiable by reading the edited file).
- Both adapter `baselineAgents()` return three-element arrays.
