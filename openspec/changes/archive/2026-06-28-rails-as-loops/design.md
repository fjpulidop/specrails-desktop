## Context

The Loops feature (in-flight `loop-builder` change) added global loop definitions, the `LoopRunManager` engine, an n8n canvas builder, `{{spec.*}}` + `{{cmd:*}}` tokens, agent-driven verify templates, and job-backed live logs. But execution is bolted onto the rail as a 4th **mode** (`loop`) next to `implement` / `batch-implement` / `freestyle`. Two problems surfaced in real use:

1. **Two launch paths / one concept.** Loops can only run via a rail in loop mode (drag a ticket), even when a loop has nothing to do with a ticket (CI watch, repo-wide lint). The mode selector and the loop picker are different mental models for the same act ("run an automation on this work").
2. **The modes already ARE loops.** `rails-router` builds `/specrails:implement #1 #2 #3 --yes` over ALL the rail's tickets for both `implement` and `batch-implement` (only the command name differs); `freestyle` is a per-ticket raw autonomous prompt (`_buildFreestylePrompt`). These map cleanly onto loop graphs driven by commands.

This change unifies the concept: **a rail applies a Loop to its tickets.** The modes become built-in "factory" loops.

## Goals / Non-Goals

**Goals:**
- One concept on the rail: pick a Loop (factory or custom) + provider + effort + tickets → Play. No mode selector.
- `implement` / `batch` / `freestyle` shipped as factory loops, expressed via catalog commands.
- A command declares its **ticket scope** (all-in-one vs per-ticket); the engine honours it.
- Ticket-less loops run from the Loops page; ticket loops from the rail; the split is auto-detected.
- Zero regression: existing rails, the `rails.mode` column, REST `mode`, and the frozen mobile wire keep working.

**Non-Goals:**
- Full engine merge (re-running implement/batch/freestyle THROUGH `LoopRunManager`). Deferred — factory loops keep using the battle-tested QueueManager path.
- Scheduled / event-triggered loops (cron, on-commit). Future.
- Changing what `/specrails:implement` etc. do internally (specrails-core is untouched).

## Decisions

### D1 — A rail applies a Loop; modes are derived, not chosen
The rail header drops the mode segmented control and gains a **Loop picker** (factory + custom). The persisted `rails.mode` column stays as a back-compat shadow: it is DERIVED from the chosen factory loop (`implement`→`implement`, `batch`→`batch-implement`, `freestyle`→`freestyle`, custom→`loop`). The REST `mode` field and the mobile wire continue to read/write it.
**Alternative**: drop `mode` entirely. **Rejected** — breaks the frozen mobile contract + needs a destructive migration.

### D2 — Factory loops are app-owned, locked, forkable
`implement` / `batch` / `freestyle` ship as built-in loop definitions surfaced in the Loops gallery as read-only (locked) with a "Fork to edit" action that clones into an editable user draft. They are NOT user-editable in place (their behaviour is contractually tied to the core commands).
**Alternative**: hide them from the gallery (rail-only). **Rejected** — the gallery is the one place to see/preview every loop; hiding them re-creates the "where do factory loops live?" confusion.

### D3 — Ticket scope is a property of the COMMAND
A catalog command declares `ticketScope: 'all' | 'per-ticket'`. `implement`/`batch` = `all` (one run, inject `{{spec.ids}}` = `#1 #2 #3`); `freestyle` = `per-ticket` (one run per ticket, inject `{{spec.id}}`). The launch path reads the loop's command(s) to decide how many runs to spawn and which ticket token to fill.
**Alternative**: scope on the loop, or a rail toggle. **Rejected** — scope is intrinsic to what the command does (the user already agreed: "lo declara el comando"); putting it on the loop/rail duplicates that truth and lets them disagree.

### D4 — `{{cmd:freestyle}}` is a "native/raw" command, not a slash command
The catalog grows a command kind beyond `coreCommand` (slash) and `template` (curated prompt): a **native** command whose expansion is the raw autonomous prompt (`_buildFreestylePrompt`'s shape), claude-only. Resolution gates: a loop containing a native claude-only command forces `provider: 'claude'` and no profile (mirrors today's freestyle guard in rails-router).
**Alternative**: model freestyle as a `template` curated prompt. **Rejected** — it must reuse the exact, tested freestyle prompt-building, not a paraphrase.

### D5 — Engine routing: ALL chosen loops → LoopRunManager when Loops enabled (REVISED 2026-06-25, per user "autonomy 0→100")
When Loops are enabled and a rail picks a loop (factory OR custom), it runs through `LoopRunManager` — so the **factory loops get the autonomous verify→fix loop too** (`{{cmd:implement}}` → `{{cmd:verify}}` → on fail `{{cmd:fix}}` → re-verify, until green). A factory loop is resolved from `loop-factory.ts` (`getFactoryLoop`) and a custom loop from the store (published). The legacy bare-mode `QueueManager` path (single `/specrails:implement` job, full profiles/plugins/provenance/OTEL integration) is the **fallback** when Loops are disabled OR no loopId is sent (mobile / legacy). `mode` is still derived from the factory loop for the `rails.mode` column.
**Trade-off (user-accepted):** running implement/batch via `LoopRunManager` loses QueueManager's profiles/plugins/provenance/OTEL integration for that step, in exchange for a fully-autonomous fix loop (no human intervention). **Originally** this change deferred the merge (factory→QueueManager); the user explicitly chose the fix-loop, accepting the trade-off.

### D5b — `{{cmd:fix}}` refinement command + `fixLoopGraph`
A `{{cmd:fix}}` catalog command (provider-invariant `template`) tells the agent to fix ONLY the failures the verify step reported (smallest change, no re-implement, no unrelated edits). The `fixLoopGraph(mainPrompts, goal)` builder wires `main → verify → decider → (continue) fix → verify` so the loop refines and re-verifies until the Decider sees `VERIFICATION: PASS`. Used by the factory loops (implement/batch/freestyle) and the agent-driven templates that apply (Ship & Green, Verify Pass). The domain templates (lint/type/build/coverage) keep their single run-and-fix step; ci-watch/deploy-check are poll-only watch loops.

### D6 — Ticket-need is auto-detected, driving WHERE a loop launches
A loop "needs a ticket" iff its graph references `{{spec.*}}` or a ticket-scoped `{{cmd:*}}`. Ticket-needing loops appear in the rail Loop picker and require ≥1 ticket; ticket-less loops show a "Run" button on the Loops page (pick a project, no ticket). No manual scope field.
**Alternative**: a manual `scope: spec | project` field on the loop. **Rejected for v1** — derivable from tokens; a manual field is one more thing to get wrong. (May revisit if detection proves too implicit.)

## Risks / Trade-offs

- **Back-compat of `rails.mode`** → Keep the column + derive it from the chosen factory loop; map factory loop ⇄ mode in one place (`rail-loop-resolution`). Existing rails (which have a `mode` but no `selectedLoopId`) resolve to the matching factory loop on read.
- **Mobile wire** → The mobile app still sends/reads `mode`; the server keeps accepting it and maps mode→factory loop, so a v1 mobile client is unaffected.
- **Auto-detection feels implicit** → Surface it: the rail Loop picker only lists ticket-needing loops; the Loops page "Run" only shows for ticket-less loops; a tooltip explains why a loop isn't selectable on a rail.
- **Two engines, one concept** → A factory loop and a custom loop with identical-looking graphs run on different engines; document it and make the routing a single resolver so behaviour is predictable.
- **Freestyle claude-only inside a unified picker** → The rail must reject/disable an freestyle loop when the rail's provider isn't claude (reuse the existing guard), with a clear message.

## Migration Plan

1. Add factory loops + new catalog commands + `{{spec.ids}}` + command `ticketScope` (additive; no behaviour change until the rail UI switches).
2. Add the rail's loop-resolution layer (factory loop ⇄ mode) behind the existing mode path — a rail with a `mode` and no `selectedLoopId` resolves to the matching factory loop.
3. Switch the rail UI from mode selector → Loop picker (factory + custom), writing both `selectedLoopId` and the derived `mode`.
4. Add the Loops-page "Run" for ticket-less loops.
5. **Rollback**: the `mode` path is never removed in this change, so reverting the UI restores the old behaviour with no data migration.

## Open Questions

- Should forking a factory loop pre-expand its commands (so the user sees the real prompt) or keep the `{{cmd:*}}` tokens? (Lean: keep tokens — that's the whole point of the catalog.)
- Do we keep the standalone rail `loop` mode value in `VALID_MODES` for custom-loop rails, or always derive `mode='loop'` for any custom loop? (Lean: derive.)
