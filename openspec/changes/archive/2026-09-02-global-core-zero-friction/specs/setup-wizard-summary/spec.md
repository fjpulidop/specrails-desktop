# setup-wizard-summary — delta

## REMOVED Requirements

### Requirement: Setup summary reports per-namespace command counts
**Reason**: The wizard completion screen consuming the summary is removed by `global-core-zero-friction`; assembly is silent and emits progress events, not a summary UI payload.
**Migration**: Assembly outcome is conveyed by `project.assemble_progress` (`silent-project-add`); diagnostics live in server logs.

### Requirement: Setup summary carries install tier
**Reason**: There is no user-selectable tier; the wizard and its summary are removed.
**Migration**: The internal quick-branch plumbing may remain server-side; no consumer-facing tier field exists.

### Requirement: Setup process removes deprecated /sr: commands
**Reason**: Per-project install runs no longer happen; legacy artifact cleanup is subsumed by the manifest-driven repo cleanup.
**Migration**: `legacy-install-migration` deletes framework-owned command directories (including any legacy `sr/`) via the manifest during forced migration.

### Requirement: Completion screen renders truthful tile grid
**Reason**: The completion screen no longer exists.
**Migration**: None — no replacement UI; the project card's ready state is the only completion signal.

### Requirement: Completion screen announces legacy /sr: cleanup
**Reason**: The completion screen no longer exists.
**Migration**: Legacy cleanup outcomes are recorded in the migration journal (`legacy-install-migration`).

### Requirement: Intro paragraph matches rendered tiles
**Reason**: The completion screen no longer exists.
**Migration**: None.
