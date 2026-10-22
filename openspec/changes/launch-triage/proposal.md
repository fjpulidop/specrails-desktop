## Why

Every spec reaches a rail without any judgement about its shape: the user picks a
loop by habit, the mission's rail-launch card explains its choice in prose, and
nothing records whether the loop a spec actually ran on was the right one. The
external feedback (feedback-2026-10, task 2.1 and annex D.2) asks for a cheap,
deterministic-first triage per spec that recommends a loop, that the rail can
preselect, and whose accuracy can be measured later by loop economics.

## What Changes

- **Spec triage** (`server/modules/specs/domain/triage.ts` pure + `runtime/triage.ts`
  effects). Deterministic inputs first — the ticket text, the deterministic
  repository map (packages + manifests + README excerpt), the files touched by
  similar tickets (`file_provenance`), the available loops and Flow availability —
  canonicalised and hashed (`sha256`). One structured-output call on the cheapest
  model of the project's primary provider (or the `triage` role engine) produces
  `metadata.triage` per annex D.2: `size`, `filesLikely`, `publicInterfaces`,
  `dataModel`, `securitySurface`, `recommendedLoop` (always an available loop id),
  `recommendedMode` (`implement` | `flow` hint, `implement` when Flow is
  unavailable), `rationale`, `confidence`, `inputsHash`, `model`, `costUsd`
  (provider-reported or `null`), `computedAt`. Same hash ⇒ no recompute. No usable
  model ⇒ `{ status: 'unavailable', reason }`, never invented values. A broken
  answer is repaired when possible and recorded as `failed` otherwise.
- **Triggers.** Spec create/edit schedules triage asynchronously (debounced,
  non-blocking, only for `draft`/`todo` specs whose content changed) by observing
  the project's ticket broadcasts, so every creation door is covered.
  `POST /:projectId/tickets/:id/triage` recalculates on demand (forced).
- **Accounting.** New `triage` surface in `ai_invocations` and the spending
  breakdowns, with a client label in the 8 locales.
- **Role engine.** `triage` joins the Desktop-owned role engines
  (`loop-role-engines.json`, `GET/PUT /agent-runtime/loop-roles`); absent ⇒ the
  primary provider's cheapest priced model.
- **UI.** A triage chip on every spec card (size · recommended loop ·
  confidence; tooltip with rationale, likely files and **Recalculate**). The rail
  header preselects the recommended loop of its first triaged spec while the
  user has not chosen one, marking it as recommended; any explicit choice wins.
  The mission rail-launch card shows the structured triage instead of prose when
  the specs carry one.
- **Delivery records.** Each isolated rail launch stores `recommended_loop` and
  `chosen_loop` on `rail_pr_deliveries` (migration 76) and `getTriageAccuracy`
  returns matched/total for loop economics.

## Capabilities

### New Capabilities
- `spec-triage`: triage inputs, hashing, structured output, triggers, unavailable
  path, accounting surface, UI chip and preselection, delivery recording and the
  accuracy aggregate.

## Impact

- **Server:** `server/modules/specs/{domain,runtime}/triage*.ts` (new),
  `ticket-store.ts` (`metadata.triage`, schema stays 1.5 — bumped by Flow on this
  stack), `project-registry.ts` (composition + broadcast tap),
  `project-router-tickets.ts` (route), `loop-role-engines.ts` (`triage` role),
  `accounting` surfaces, `rails-router.ts` / `rail-isolated-launch.ts` /
  `rail-pr-store.ts` (loop choice), `db/migrations.ts` (76).
- **Client:** `SpecTriageChip` (new), `SpecCard`, `rail-loops.ts`, `RailRow`,
  `RailLoopSelector`, `DashboardPage`, `AgentRailLaunchCard`, analytics surfaces,
  i18n `specs`/`dashboard`/`analytics`/`agent` ×8.
- **Core:** none. Core ignores unknown ticket metadata.
- **Docs:** `docs/internals/spec-triage.md` (new), `configuration.md`,
  `api-reference.md`, module READMEs, source map.
