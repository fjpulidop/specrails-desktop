## Why

Today a rail forces the user to pick a **mode** (`implement` / `batch-implement` / `ultracode` / `loop`) plus options, and loops can ONLY be launched by switching a rail into loop mode and dragging a ticket — even loops that have nothing to do with a ticket (CI watch, repo-wide lint). This creates two confusing launch paths and an awkward split between "modes" and "loops". In reality the modes ARE loops: `implement`/`batch` already invoke `/specrails:implement #1 #2 #3 --yes` over all the rail's tickets, and `ultracode` is a per-ticket autonomous prompt. Unifying everything under one concept — *"a rail applies a Loop to its tickets"* — removes the confusion and makes the loops feature land coherently.

## What Changes

- **Rails pick a Loop, not a mode.** The mode segmented control (`implement`/`batch`/`ultra`/`loop`) is replaced by a **Loop picker**. A rail = drag ticket(s) + pick a Loop + provider + effort + Play. **BREAKING** (UI/UX of the rail header; the `rails.mode` column is preserved for back-compat — see Impact).
- **`implement`, `batch`, `ultracode` become built-in "factory" Loops** shipped by the app, shown in the Loops gallery as locked/read-only with a "Fork to edit" affordance, alongside the user's custom loops.
- **New magic commands** in the loop command catalog: `{{cmd:batch}}` (core `batch-implement`) and `{{cmd:ultracode}}` (a **raw/native** command, claude-only — NOT a slash command), joining the existing `{{cmd:implement}}`.
- **Ticket scope is declared by the command**: `implement`/`batch` = all the rail's tickets in ONE run; `ultracode` = one run per ticket. The engine reads the command's scope to decide run count + how many ticket ids to inject.
- **New token `{{spec.ids}}`** = all the rail's ticket ids joined as `#1 #2 #3` (used by implement/batch); existing `{{spec.id}}` stays as a single id.
- **provider + model + reasoning effort stay on the rail** (rail-governed — already the case); the Loop carries only the pipeline/steps.
- **Ticket-less loops run independently** from the Loops page via a "Run" button (pick a project, no ticket). Whether a loop needs a ticket is auto-detected from its use of `{{spec.*}}` / ticket-scoped `{{cmd:*}}`.
- **Engine strategy (phase A)**: factory loops route to the EXISTING engine (QueueManager + slash command / `_buildUltracodePrompt`); custom loops route to `LoopRunManager`. The user sees one concept; a full engine merge is explicitly deferred.

## Capabilities

### New Capabilities
- `factory-loops`: the built-in implement/batch/ultracode loops, their catalog commands (`{{cmd:batch}}`, `{{cmd:ultracode}}`), command-declared ticket scope, the `{{spec.ids}}` token, and the locked/fork gallery behaviour.
- `rail-loop-execution`: the rail applies a chosen Loop to its tickets (no mode selector); provider/effort are rail-governed; execution routes factory→existing engine and custom→LoopRunManager; the legacy `rails.mode` + REST + mobile wire stay compatible.
- `standalone-loop-run`: launching a ticket-less loop from the Loops page ("Run" → pick project), with auto-detection of whether a loop requires a ticket.

### Modified Capabilities
<!-- The loops feature lives in the in-flight `loop-builder` change (not yet archived to openspec/specs/), so there are no published specs to modify; rails-as-loops adds new capabilities that build on it. -->

## Impact

- **Server**: `server/rails-router.ts` (mode → loop routing), `server/queue-manager.ts` (implement/batch/ultracode engine + slash translation + `_buildUltracodePrompt`), `server/loop-command-catalog.ts` (new commands + scope), `server/loop-templates.ts` (factory loops), `server/loop-run-manager.ts` / `server/loop-executors.ts` (`{{spec.ids}}`, command scope, run count), `server/loops-router.ts` (standalone run endpoint), `server/loops-store.ts` (factory/locked flag).
- **Client**: `RailControls` / `RailRow` / `RailsBoard` / `DashboardPage` (replace mode selector with Loop picker), `LoopsPage` + `TemplatePreviewModal` (factory loops locked + Fork, "Run" button), `provider-capabilities` (claude-only ultracode loop).
- **Data / contracts**: `rails.mode` column preserved (mode derived from / mapped to the chosen factory loop); rails REST `mode` field kept; the **frozen mobile wire** (`hub.*` types, mDNS `specrailshub`, QR payload fields) must not change.
- **Depends on** the in-flight `loop-builder` change (loops engine, canvas, tokens, job-backed logs).
- **Out of scope (deferred)**: full engine merge (everything through `LoopRunManager`); scheduled/event-triggered loops; **per-loop analytics rollup** ("this loop's total cost/runs across projects") — each standalone run is already tracked in its target project (job + `ai_invocations surface='loop'`), so a cross-run/cross-project per-loop view is deferred (Option A).
