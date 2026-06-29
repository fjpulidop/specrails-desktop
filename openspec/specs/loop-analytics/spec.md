# loop-analytics Specification

## Purpose
TBD - created by archiving change loop-builder. Update Purpose after archive.
## Requirements
### Requirement: Loop invocation surface on the per-project analytics page

The per-project AnalyticsPage SHALL add a new `loop` invocation surface additively, mirroring every existing surface (`job`, `quick-spec`, `explore-spec`, `ai-edit`, `file-summary`). The `loop` surface MUST appear as a filter chip in the sticky filter header, be assigned a distinct semantic theme colour (a token from the existing palette, never a brand-named colour), be included in the daily stacked cost timeline, contribute points to the cost-vs-turns scatter, appear in the by-surface breakdown, and be selectable in both summary and raw export modes. Existing surfaces MUST continue to render byte-identically when no loop invocations exist.

#### Scenario: Loop filter chip filters the dashboard
- **WHEN** the user clicks the `loop` filter chip in the analytics filter header
- **THEN** the dashboard refetches with `surface=loop` and all blocks (hero, timeline, scatter, by-surface, top tickets, raw table) render only loop invocations
- **AND** the `?surface=loop` query param is URL-synced so a refresh restores the filtered view

#### Scenario: Loop surface participates in the timeline and scatter
- **WHEN** the project has at least one `loop` invocation in the selected period
- **THEN** the daily stacked cost timeline renders a `loop` band using the surface's assigned colour
- **AND** the cost-vs-turns scatter includes the loop invocations as points coloured by that same surface colour

#### Scenario: Loop surface is included in exports
- **WHEN** the user exports analytics as Summary CSV or Raw CSV with no surface filter applied
- **THEN** the export includes `loop` rows in the by-surface section and in the raw invocation rows alongside the existing surfaces
- **AND** filtering the export to `surface=loop` yields only loop rows

### Requirement: Loop run AI invocations are recorded under the loop surface

Every AI invocation produced during a loop run — including each AI Step node call and every Loop Decider call — SHALL write a row to `ai_invocations` with `surface="loop"` and the run's `loop_run_id` set. Recording MUST occur at process exit via the shared `recordInvocation` path so model, tokens (in/out/cache), cost, turns, duration, and status are captured identically to other surfaces. After each recorded row the server MUST emit the project-scoped `spending.invalidated` broadcast so any open analytics dashboard refreshes live.

#### Scenario: AI Step and Decider calls both record under loop
- **WHEN** a loop run completes after two iterations, each running one AI Step and one Loop Decider call
- **THEN** four `ai_invocations` rows exist with `surface="loop"` and the same `loop_run_id`, each carrying model, tokens, cost, turns, duration, and status
- **AND** failed or aborted invocations are written with their status and excluded from cost averages but counted in totalRuns

#### Scenario: Live dashboard refresh on new loop invocation
- **WHEN** a loop invocation row is recorded while an analytics dashboard is open
- **THEN** the server broadcasts `spending.invalidated` scoped to the project
- **AND** the open dashboard debounces and refetches so the new loop cost appears without a manual reload

### Requirement: Per-project Loops run-metrics block

The per-project AnalyticsPage SHALL render a new "Loops" run-metrics block sourced from the per-project `loop_runs` table, distinct from the cost-oriented invocation surface block. The block MUST surface: the number of loop runs, the success rate (runs that reached a `stop` decision versus runs that terminated by hitting `maxIterations`), the average iterations to completion, the iteration-count distribution, and the top loop by usage. When the project has no loop runs the block MUST render a sparse-data empty state rather than blank or error content.

#### Scenario: Run-metrics computed from loop_runs
- **WHEN** the project has loop runs of which some reached a stop decision and some hit max iterations
- **THEN** the Loops block displays the run count, the success rate as stops over total runs, the average iterations across completed runs, the iteration-count distribution, and the most-used loop by run count

#### Scenario: Empty Loops block
- **WHEN** the project has zero rows in `loop_runs`
- **THEN** the Loops run-metrics block renders a sparse-data empty state and shows no spurious zero-division values

### Requirement: Cross-project loop metrics in the global analytics modal

The global analytics modal SHALL be extended with cross-project loop metrics, aggregated across all projects by iterating each project database exactly as the modal already iterates per-project stats. The aggregation MUST surface the top loops by usage, the top loops by cost, the global loop success rate, and the global average iterations. Projects with no loop runs MUST contribute nothing and never cause the aggregation to fail.

#### Scenario: Aggregate across all project databases
- **WHEN** the global analytics modal is opened and two projects each have loop runs
- **THEN** the modal aggregates `loop_runs` and `loop`-surface invocations across both project databases and renders top loops by usage, top loops by cost, global success rate, and average iterations

#### Scenario: Projects without loops are skipped safely
- **WHEN** a registered project has no `loop_runs` rows
- **THEN** that project contributes zero loop runs and zero loop cost to the global aggregation
- **AND** the aggregation completes without error and excludes the project from the top-loops listings

### Requirement: Accurate loop cost reporting with estimation flag

Loop invocation cost SHALL be reported accurately per provider: when the provider reports a native `total_cost_usd` it MUST be used as-is; when the provider does not report native cost the value MUST be computed from the pricing rate-card table and flagged as estimated. The estimated flag MUST be preserved through aggregation into the per-project and global loop metrics so the UI can mark estimated cost distinctly from native cost.

#### Scenario: Native cost used when provider reports it
- **WHEN** a loop AI Step runs on a provider that reports native `total_cost_usd`
- **THEN** the recorded `ai_invocations.total_cost_usd` is the native value and is not flagged as estimated

#### Scenario: Estimated cost from pricing table
- **WHEN** a loop AI Step runs on a provider that does not report native cost
- **THEN** the cost is computed from the pricing rate-card using the recorded model and token counts
- **AND** the value is flagged as estimated so both the per-project Loops block and the global modal surface it as estimated

### Requirement: Loop analytics strings available in all locales

All new user-facing strings introduced by loop analytics — the `loop` filter chip label, the surface name, the Loops run-metrics block labels, and the global modal loop-metrics labels — SHALL be defined in the `loops` i18n namespace for every one of the 8 supported locales (`en`, `es`, `fr`, `de`, `pt`, `it`, `zh`, `ja`). English MUST be the source-of-truth locale, and the key-parity test MUST pass with identical key trees and `{{placeholders}}` across all locales. No loop analytics string may be hardcoded in a component.

#### Scenario: Key parity across all 8 locales
- **WHEN** the locale key-parity test runs over the `loops` namespace
- **THEN** every locale mirrors the English key tree and placeholder set exactly with no missing or extra keys
- **AND** the test fails if any loop analytics string is added to English without a corresponding key in all other locales

#### Scenario: No hardcoded analytics strings
- **WHEN** the loop analytics filter chip, Loops block, and global modal metrics render
- **THEN** every user-visible label resolves through `t()` against the `loops` namespace
- **AND** switching the app language re-renders these labels in the selected locale without a restart

