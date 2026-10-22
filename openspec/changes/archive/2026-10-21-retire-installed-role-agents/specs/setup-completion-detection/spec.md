## ADDED Requirements

### Requirement: Setup completion is decided by workflow commands
Desktop SHALL mark a provider workspace as a complete Core installation when the provider's workflow commands (`/specrails:*` or `/opsx:*` namespaces, or their skill equivalents for codex and kimi) are present. It SHALL NOT require any role agent file (`sr-*`) for that decision, and SHALL NOT expose an `agent_generation` checkpoint in the full-install flow.

#### Scenario: Core 6.3 install without role files
- **WHEN** `.claude/commands/specrails/implement.md` exists and `.claude/agents` does not
- **THEN** `setupArtifactState` reports `complete: true` and the checkpoint list contains no `agent_generation` key

#### Scenario: Older install with role files
- **WHEN** a workspace holds `.claude/agents/sr-developer.md` and `.claude/commands/specrails/implement.md`
- **THEN** completion is `true` and the role file does not change the result

#### Scenario: Commands missing
- **WHEN** a workspace holds only `.claude/agents/custom-mine.md`
- **THEN** completion is `false`

### Requirement: Setup summary counts custom roles as agents
`computeSummary` SHALL report `agents` as the number of custom roles in the provider's native catalog (`custom-*.md` under `agents/` for claude and gemini, `skills/rails/custom-*/SKILL.md` for codex, `skills/custom-*/SKILL.md` for kimi) and SHALL NOT count `sr-*` entries.

#### Scenario: Custom and stale framework roles
- **WHEN** `.claude/agents` holds `custom-serena.md` and a stale `sr-architect.md`
- **THEN** the summary reports `agents: 1`

### Requirement: No per-spawn framework agent repair
Rail and loop spawns SHALL NOT copy framework role agents into the workspace; the command-subtree repair for Windows remains.

#### Scenario: Windows relocated workspace spawn
- **WHEN** a rail spawns on a relocated Windows workspace
- **THEN** no file is written under `<providerDir>/agents` by the spawn path and the command subtrees are still repaired
