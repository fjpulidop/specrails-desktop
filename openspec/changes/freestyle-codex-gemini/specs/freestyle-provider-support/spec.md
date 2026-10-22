## ADDED Requirements

### Requirement: Freestyle provider support

Desktop SHALL offer non-interactive Freestyle on every provider adapter whose `capabilities.freestyle` is true. The bundled Claude, Codex, Gemini and Kimi adapters and every local engine SHALL advertise it. A rail launch, a custom loop using `{{cmd:freestyle}}`, and the `factory:freestyle` listing SHALL be refused or hidden for a provider that does not advertise it. The client SHALL mirror the server capability for bundled CLIs and local engines and SHALL NOT offer Freestyle for the `roles` sentinel or an unresolved provider.

#### Scenario: Codex or Gemini launches Freestyle

- **WHEN** a rail whose engine is Codex or Gemini launches `mode: 'freestyle'`
- **THEN** the launch SHALL be accepted
- **AND** each ticket SHALL run without an explicit interactive selection

#### Scenario: A provider without the capability

- **WHEN** a rail launches Freestyle on a provider whose adapter does not advertise `freestyle`
- **THEN** the launch SHALL fail with `Freestyle is not supported by provider '<id>'`
- **AND** no job or loop run SHALL start

### Requirement: Interactive Freestyle stays persistent-stdin only

The interactive Freestyle variant (in-job chat settled by Finalize) SHALL require `capabilities.persistentStdin`. A Freestyle run on a provider without persistent stdin SHALL run non-interactively and settle through verification and the Loop Decider.

#### Scenario: Codex Freestyle is non-interactive

- **WHEN** Freestyle runs on Codex or Gemini
- **THEN** no interactive session SHALL be planned for it
- **AND** the run SHALL settle from Core's verified completion

### Requirement: Real-run evidence before enabling a provider

A provider's `freestyle` capability SHALL be enabled only after a real end-to-end Freestyle run on that provider succeeds through Desktop's production loop executor and a built Core: the agent writes code, configured verification runs, the Loop Decider returns a verdict and the run settles with verified completion. The opt-in live test `loop-factory-freestyle.live.test.ts` SHALL reproduce that run and SHALL be skipped unless `SPECRAILS_LIVE_FREESTYLE_PROVIDERS` names the providers.

#### Scenario: Live smoke is opt-in

- **WHEN** the test suite runs without `SPECRAILS_LIVE_FREESTYLE_PROVIDERS`
- **THEN** the live Freestyle test SHALL be skipped and SHALL spawn no provider

#### Scenario: Live smoke proves a provider

- **WHEN** the live test runs for a provider
- **THEN** it SHALL assert `runtimeStatus: 'succeeded'` with `completion { ok: true, verified: true }`, successful `implement`, `verify` and `decide` steps, and an independent re-run of the verification command
- **AND** it SHALL accept a missing cost only as `estimated: true`, never as a fabricated value

### Requirement: Core-spawned Gemini trusts the admitted workspace

Desktop SHALL pass `GEMINI_CLI_TRUST_WORKSPACE=true` in the environment of every Core runtime invocation unless the host environment already sets that variable, so Gemini CLI steps run in projects and rail worktrees that were never trusted interactively.

#### Scenario: Fresh worktree on Gemini

- **WHEN** Core spawns Gemini for a workflow step in a folder Gemini has never trusted
- **THEN** the Gemini process SHALL receive `GEMINI_CLI_TRUST_WORKSPACE=true`
- **AND** an explicit host value SHALL be preserved unchanged
