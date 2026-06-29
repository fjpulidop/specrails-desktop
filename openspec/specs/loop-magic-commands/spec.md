# loop-magic-commands Specification

## Purpose
TBD - created by archiving change loop-template-library. Update Purpose after archive.
## Requirements
### Requirement: Provider-Aware Loop Command

The magic-command catalog SHALL provide a `loop` command, referenced as `{{cmd:loop}}`, that expands to the agent-native autonomous-loop entry point of the run's provider: `/loop` for Claude and `$goal` for Codex. For any provider without a native loop entry point, `{{cmd:loop}}` SHALL expand to a self-contained autonomous-loop prompt preamble instead, so the command remains usable on every provider. The command SHALL be invocable inside an AI Step and SHALL NOT be restricted to a single provider.

#### Scenario: Loop command expands per provider

- **WHEN** `{{cmd:loop}}` is expanded for the Claude provider
- **THEN** it SHALL expand to Claude's native loop invocation (`/loop`)
- **WHEN** `{{cmd:loop}}` is expanded for the Codex provider
- **THEN** it SHALL expand to Codex's native loop invocation (`$goal`)

#### Scenario: Loop command falls back on providers without a native entry point

- **WHEN** `{{cmd:loop}}` is expanded for a provider that has no native loop entry point (e.g. Gemini)
- **THEN** it SHALL expand to a self-contained autonomous-loop prompt preamble rather than an empty string

#### Scenario: Loop command is not provider-restricted

- **WHEN** a template or loop references `{{cmd:loop}}`
- **THEN** the loop SHALL NOT be flagged as restricted to the Claude provider on account of that token

### Requirement: Provider-Native Command Resolution

The command model SHALL support a per-command map of provider-native invocation prefixes. When expanding a command for a given provider, a provider-native prefix listed for that provider SHALL take precedence over the command's generic template; providers not listed SHALL fall back to the generic template. This resolution SHALL NOT change the expansion of existing commands that do not declare provider-native prefixes.

#### Scenario: Provider-native prefix wins for listed providers

- **WHEN** a command declares a provider-native prefix for a provider and is expanded for that provider
- **THEN** the expansion SHALL use the provider-native prefix

#### Scenario: Unlisted providers fall back to the template

- **WHEN** a command declaring provider-native prefixes is expanded for a provider not in its map
- **THEN** the expansion SHALL use the command's generic template

#### Scenario: Existing commands are unaffected

- **WHEN** a command that declares no provider-native prefixes is expanded for any provider
- **THEN** its expansion SHALL be identical to its expansion before this change

### Requirement: Distilled Common Magic Commands

The catalog SHALL provide reusable, provider-invariant magic commands for the workflow steps that recur across the template library, including at minimum: `test`, `lint`, `typecheck`, `build`, `coverage`, `format`, `commit`, `push`, `pr`, `ci-status`, `audit`, `docs-sync`, and `review`. Each SHALL instruct the agent to detect the project's own tooling rather than assume a specific stack, and each command that mutates code or tests SHALL embed the guardrails contract. These additions SHALL be append-only and SHALL automatically appear as chips in the builder command palette.

#### Scenario: Common commands are present and resolvable

- **WHEN** the command catalog is enumerated
- **THEN** each of the distilled common commands SHALL be present
- **AND** each SHALL expand to a non-empty prompt for every provider

#### Scenario: Common commands are tooling-agnostic

- **WHEN** a distilled command (e.g. `{{cmd:test}}`) is expanded
- **THEN** the expansion SHALL instruct the agent to detect the project's tooling
- **AND** the expansion SHALL NOT hardcode a single stack's command as the only option

#### Scenario: Mutating commands carry the guardrails

- **WHEN** a distilled command that modifies code or tests is expanded
- **THEN** its expansion SHALL include the guardrails contract

#### Scenario: New commands surface in the palette

- **WHEN** the builder requests the command catalog via `GET /api/loops/commands`
- **THEN** the response SHALL include each newly added command's `name`, `label`, and `description`

### Requirement: OpenSpec Lifecycle Magic Commands

The magic-command catalog SHALL include provider-aware commands `opsx:ff`, `opsx:apply`, and `opsx:verify`. Each SHALL be a `providerNative` command mapping `claude` and `gemini` to the slash form `/opsx:<name>` and `codex` to the dollar form `$opsx:<name>`, with a `template` fallback prompt for any provider not in the map. These commands SHALL NOT be modeled as `coreCommand` entries (which emit `/specrails:<name>`), because the OpenSpec commands live under the `/opsx:` namespace. No `opsx:archive`/`opsx:bulk-archive` command is added (archive is invoked via the `openspec` CLI in a shell node and is provider-independent).

#### Scenario: opsx commands expand per provider
- **WHEN** `{{cmd:opsx:ff}}` is expanded for the `claude` provider
- **THEN** the result is `/opsx:ff`

#### Scenario: codex uses the dollar form
- **WHEN** `{{cmd:opsx:apply}}` is expanded for the `codex` provider
- **THEN** the result is `$opsx:apply`

#### Scenario: gemini uses the slash form
- **WHEN** `{{cmd:opsx:verify}}` is expanded for the `gemini` provider
- **THEN** the result is `/opsx:verify`

#### Scenario: unknown provider falls back to the template prompt
- **WHEN** `{{cmd:opsx:ff}}` is expanded for a provider absent from the providerNative map
- **THEN** the result is the command's fallback template prompt, not an empty string

