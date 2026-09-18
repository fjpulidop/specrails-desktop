## ADDED Requirements

### Requirement: Connections card replaces the basic form
Settings ▸ Specrails Agents SHALL render a Provider connections card listing every connection: CLI rows (read-only status from provider detection) and local rows (editable). A local row SHALL show a status pill (`probing` / `reachable` / `not authorized` / `unreachable`), base URL, API-key env name, discovered models, default model, and optional rates. Add / rename / remove / save SHALL persist through `PUT /api/runtime-providers`. Text SHALL come from i18n (`settings`, `agentRuntime`) in all eight locales.

#### Scenario: Card renders configured connections
- **WHEN** the connections file holds four CLI rows and `local`
- **THEN** the card shows five rows, `local` editable with its URL and env name

### Requirement: Test connection
The card SHALL offer **Test connection** per local row calling `POST /api/runtime-providers/test` with the row's draft `{ baseUrl, apiKeyEnv }`; the response `{ reachable, authState, models, latencyMs, error? }` SHALL update the pill and the models list without saving. When `apiKeyEnv` names a variable that is not set in the server process the response SHALL include `apiKeyEnvMissing: true` and the card SHALL show a hint.

#### Scenario: Successful test
- **WHEN** the endpoint answers `/models` with two ids in 80 ms
- **THEN** the pill reads reachable, both models are listed, and the default-model picker is enabled

#### Scenario: Env var missing
- **WHEN** `apiKeyEnv` is `LOCAL_OLLAMA_API_KEY` and the server env lacks it
- **THEN** the response carries `apiKeyEnvMissing: true` and the card shows the not-set hint

### Requirement: Saving re-syncs engines live
A successful save SHALL re-register local adapters, re-probe local connections, and broadcast `providers.detected_changed` when the usable set changed, so open engine selectors update without a reload.

#### Scenario: New connection appears in selectors
- **WHEN** the user adds `lan-box`, tests it reachable and saves
- **THEN** within the same session the rail engine selector lists `lan-box`

### Requirement: Rates and default model are additive fields
`runtime-providers.json` local entries MAY carry `label`, `defaultModel`, `rates { inputPer1M, outputPer1M }` (non-negative numbers) and `supportsReasoningEffort`. Files without them SHALL load unchanged; validation SHALL reject negative rates.

#### Scenario: Legacy file loads
- **WHEN** the file has only `{ id, kind, baseUrl, apiKeyEnv }` entries
- **THEN** load succeeds and the card shows no default model and no rates

### Requirement: MCP exposure
`specrails_settings` SHALL expose `runtime_providers.list` (read), `runtime_providers.test` (read), and `runtime_providers.save` (write) mirroring the REST routes and tiers.

#### Scenario: Agent tests a connection
- **WHEN** an MCP client calls `specrails_settings(runtime_providers.test, { baseUrl })`
- **THEN** it receives the same `{ reachable, authState, models }` shape the card uses
