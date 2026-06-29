## ADDED Requirements

### Requirement: OpenSpec Lifecycle Loop Template

The system SHALL provide a starter loop template named `opsx-lifecycle` that, given a single Specrails ticket, drives the full OpenSpec lifecycle (generate artifacts → implement → verify → archive) with a single AI agent and no multi-agent pipeline. The template SHALL be a hand-authored `LoopGraph` (not a compiled `PortSpec`) because it combines an AI-step spine, a decider, a `shell` archive node, and a terminal action on the decider's `stop` branch — a shape the stock `aiLoopGraph`/`fixLoopGraph` builders do not produce.

#### Scenario: Template is offered in the catalog
- **WHEN** a client requests the loop template catalog
- **THEN** an `opsx-lifecycle` template is present with a valid graph that passes `validateLoopGraph`

#### Scenario: Template is launchable from a ticket
- **WHEN** a rail launches the `opsx-lifecycle` template with a ticket
- **THEN** the run starts at the first `opsx:ff` step with the ticket's `{{spec.title}}` and `{{spec.description}}` interpolated into the prompt

### Requirement: Lifecycle Step Sequence

Within one iteration the template SHALL execute, in order, an `opsx:ff` ai-step (generate/amend artifacts), an `opsx:apply` ai-step (implement), and an `opsx:verify` ai-step (verify implementation against the change's specs), followed by a decider node. The template SHALL NOT include an `opsx:new` step.

#### Scenario: Steps run in lifecycle order
- **WHEN** an `opsx-lifecycle` run executes an iteration
- **THEN** the engine visits the `opsx:ff` node, then the `opsx:apply` node, then the `opsx:verify` node, then the decider node

#### Scenario: No opsx:new step exists
- **WHEN** the `opsx-lifecycle` graph is inspected
- **THEN** no ai-step expands to an `opsx:new` invocation

### Requirement: Verify-Sourced Completion Verdict

The completion decision SHALL be sourced from the `opsx:verify` step's output, not from a decider that judges only the ticket text. The decider node SHALL route to `stop` when verify reported the change complete (PASS) and to `continue` when verify reported remaining gaps (FAIL).

#### Scenario: Verify PASS exits the loop
- **WHEN** the `opsx:verify` step reports the implementation satisfies the change
- **THEN** the decider routes the `stop` branch toward the archive node

#### Scenario: Verify FAIL continues the loop
- **WHEN** the `opsx:verify` step reports remaining gaps
- **THEN** the decider routes the `continue` branch back to the `opsx:ff` step

### Requirement: Loop-Back Amends The Same Change

On a `continue` (FAIL) verdict the loop SHALL re-enter at the `opsx:ff` step targeting the SAME OpenSpec change captured on the first pass (via `{{run.changeId}}`), instructing it to continue that change and address the gaps reported by verify — never creating a duplicate change directory.

#### Scenario: Re-pass continues the existing change
- **WHEN** the loop re-enters `opsx:ff` after a FAIL verdict and a change id was captured
- **THEN** the resolved prompt names the captured change id and instructs continuation of that change with the outstanding gaps

### Requirement: Unattended Archive On Pass

On the decider's `stop` branch the template SHALL run a `shell` node executing `openspec archive <id> -y` (using `{{run.changeId}}`) — non-interactive and syncing main specs by default — and then reach the `end` node. The template SHALL NOT use `opsx:bulk-archive`.

#### Scenario: Archive runs unattended after PASS
- **WHEN** the decider routes `stop` and a change id was captured
- **THEN** a shell node runs `openspec archive <id> -y` and the run settles successfully

#### Scenario: Archive is guarded when no change id was captured
- **WHEN** the decider routes `stop` but no change id was captured
- **THEN** the archive command is not executed against an unknown change and the run settles with a clear failure reason instead of archiving the wrong change

### Requirement: Bounded Iteration

The template SHALL set a conservative `maxIterations` so a never-satisfied verify can never spin indefinitely, relying on the engine's existing iteration counter, wall-clock timeout, and optional cost cap.

#### Scenario: Loop stops at the iteration ceiling
- **WHEN** verify reports FAIL on every pass up to `maxIterations`
- **THEN** the run settles with outcome `max-iterations` rather than looping forever

### Requirement: Claude-First Provider Scope

The template SHALL function natively on providers whose CLI resolves `/opsx:*` commands (claude, and gemini per its `/opsx:` syntax). For providers lacking the native command (codex), the magic commands SHALL fall back to a template prompt rather than emitting an unresolved token. The template's description SHALL state that full multi-provider parity is claude-first.

#### Scenario: Native expansion on claude
- **WHEN** the template's `opsx:ff` command is expanded for the claude provider
- **THEN** it expands to the native `/opsx:ff` invocation

#### Scenario: Fallback expansion on a provider without the native command
- **WHEN** the template's `opsx:ff` command is expanded for a provider that has no native opsx command
- **THEN** it expands to the fallback template prompt, never to an empty string or a raw unresolved token
