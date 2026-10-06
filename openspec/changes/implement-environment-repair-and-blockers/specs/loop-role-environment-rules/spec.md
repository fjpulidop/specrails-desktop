## ADDED Requirements

### Requirement: Default developer prompt forbids temporary verification bypasses

The default developer definition in `loop-agent-defaults.json` SHALL state that validating through a temporary configuration, alternate runner or local browser the host verification plan does not use is forbidden, and that a missing project tool must be installed through the project's documented command or reported as a blocker.

#### Scenario: Prompt text

- **WHEN** the default developer definition is loaded
- **THEN** it contains the prohibition and the install-or-report rule, word for word identical to the Core builtin sentences

### Requirement: Default fixer prompt returns a structured blocker

The default fixer definition SHALL instruct the role to return `blocker: { kind, command, cwd, evidence, requiredAction }` with the allowed kinds, to make no speculative edits for an external cause, to say so in `summary`, and SHALL admit a documented idempotent toolchain install inside the admitted workspace while forbidding configuration edits.

#### Scenario: Prompt text

- **WHEN** the default fixer definition is loaded
- **THEN** it contains the `blocker` contract, the allowed kinds and the toolchain-install allowance

### Requirement: Defaults remain valid loop agent settings

The lengthened definitions SHALL pass `validateLoopRuntimeSettings` and the existing defaults tests.

#### Scenario: Validation

- **WHEN** the defaults file is validated at startup
- **THEN** no length or schema error is raised
