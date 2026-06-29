## ADDED Requirements

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
