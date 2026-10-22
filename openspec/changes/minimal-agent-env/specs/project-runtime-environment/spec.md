## ADDED Requirements

### Requirement: Projects choose the agent environment mode
Each project SHALL have an agent environment mode, `inherit` or `minimal`, defaulting to `inherit`. Desktop SHALL reject any other value and SHALL read an unknown stored value as `inherit`. Only the project settings API SHALL change the mode; MCP tools MAY report it but SHALL NOT change it.

#### Scenario: Default project
- **WHEN** a project has never set the mode
- **THEN** its agents receive exactly the environment Desktop constructed before this setting existed

#### Scenario: Invalid value
- **WHEN** a client sends `agentEnvMode: "strict"`
- **THEN** the request is rejected with 400 and nothing is written

### Requirement: Minimal mode forwards only allowlisted names
In `minimal` mode Desktop SHALL build an agent's base environment only from: a shared allowlist (path, home, user, shell, locale, temp, terminal, time zone, XDG directories, proxy variables in both cases, certificate variables); Windows essentials, matched case-insensitively on Windows; `SPECRAILS_*` variables; the auth/config names declared by the provider adapters the spawn may run; and the project's passthrough values with login-shell recovery. Specrails' own per-spawn overlays SHALL still apply on top. Each provider adapter SHALL declare its names; Core-hosted work SHALL receive the names of every registered adapter, and loop shell steps SHALL receive no provider names.

#### Scenario: Unrelated credential withheld
- **WHEN** Desktop runs with `AWS_SECRET_ACCESS_KEY` and `GITHUB_TOKEN` set and a minimal project starts a Claude rail
- **THEN** the agent process does not receive either variable and does receive `PATH`, `HOME`, `ANTHROPIC_API_KEY` and the configured passthrough names

#### Scenario: Provider names stay with their provider
- **WHEN** a minimal project starts a Codex loop step while `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set
- **THEN** the step receives `OPENAI_API_KEY` and not `ANTHROPIC_API_KEY`

#### Scenario: Windows essentials preserved
- **WHEN** a minimal project spawns an agent on Windows where the environment carries `Path`, `SYSTEMROOT` and `ComSpec`
- **THEN** those names reach the agent regardless of their casing

### Requirement: One builder for every project agent spawn path
Rail jobs, loop steps and Core definition runs, retained runtime controls, missions and their Core session host, project chats, and project spec and refinement helpers SHALL obtain their base environment from the shared project agent environment builder.

#### Scenario: Mode applied across surfaces
- **WHEN** a project switches to `minimal`
- **THEN** the next rail job, loop step, mission turn and chat turn of that project start with the minimal environment

### Requirement: Agent environment status is value-free
Desktop SHALL expose `GET /api/projects/:projectId/agent-env/status` returning the mode, the shared allowlist patterns, the Desktop variable names that pass them, the configured passthrough names and, per provider, its patterns and the extra names they admit. The response SHALL NOT contain any variable value.

#### Scenario: Status lists names only
- **WHEN** the status is read while `ANTHROPIC_API_KEY` is set
- **THEN** the response lists `ANTHROPIC_API_KEY` under the Claude provider and contains no value
