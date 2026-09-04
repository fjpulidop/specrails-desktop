# multi-provider-architecture — delta

## MODIFIED Requirements

### Requirement: POST /projects accepts any registered provider id

The app SHALL accept an optional `provider: <id>` / `providers: string[]` in the body of `POST /api/projects` for wire compatibility, validated against `providerRegistry.hasAdapter(id)` (unknown ids rejected with HTTP 400 naming the unknown id and listing registered ids). The fields SHALL NOT determine which providers the project offers: provider availability is the app-level detected set (see `provider-auto-detection`). When the fields are omitted the project registers with the detected set; when present they are accepted and recorded but the detected set remains authoritative on every read and validation.

#### Scenario: Provider field omitted
- **WHEN** a client POSTs `{ path: '/tmp/ok' }` with claude and codex detected
- **THEN** the response is HTTP 201 and the project offers both claude and codex

#### Scenario: Unknown provider id rejected
- **WHEN** a client POSTs `{ path: '/tmp/ok', provider: 'turbofake' }`
- **THEN** the response is HTTP 400 with an error naming `turbofake` as unknown and listing the registered ids

#### Scenario: Legacy client sends a provider subset
- **WHEN** a client POSTs `{ path: '/tmp/ok', providers: ['claude'] }` on a machine where codex is also detected
- **THEN** the project registers successfully and still offers codex per-invocation, because the detected set is authoritative

### Requirement: Provider field on project is immutable post-creation

The app SHALL NOT expose any endpoint that lets a user directly set a project's provider set. The stored `provider` (primary) and `providers` columns are maintained by the app: `providers` mirrors the app-level detected set, and `provider` follows the primary-derivation rule (stored primary while detected, else claude, else fixed preference order). UI surfaces SHALL render the effective provider set as informational state derived from detection, not as a per-project control.

#### Scenario: No PATCH endpoint accepts provider
- **WHEN** any `PATCH /api/projects/:id` or per-project settings endpoint is inspected
- **THEN** none of them accept a `provider` or `providers` field from the client

#### Scenario: Detected set reflected without user action
- **WHEN** a new provider CLI becomes detected
- **THEN** every project's effective provider set includes it with no per-project mutation by the user

## ADDED Requirements

### Requirement: Capability visibility is the union of detected providers

Sidebar/section visibility gating SHALL use the union rule: a provider-capability-gated section is visible when AT LEAST ONE detected provider supports it (`sectionVisibleForProviders` uses `some`, not `every`). Within a visible section, per-invocation engine selectors SHALL offer only the capable providers, and per-action validation (e.g. Kimi's gated-off safety-sensitive surfaces) remains unchanged. The single-provider invariant (selectors do not render when exactly one provider is detected) SHALL key on the detected set's size.

#### Scenario: Installing a weaker provider hides nothing
- **WHEN** gemini (no profiles support) becomes detected alongside claude
- **THEN** the Agents section remains visible and its engine-scoped affordances offer claude only

#### Scenario: Section with zero capable providers stays hidden
- **WHEN** only gemini is detected
- **THEN** sections requiring profiles support are not rendered

#### Scenario: Single provider renders no selectors
- **WHEN** exactly one provider is detected
- **THEN** engine selectors do not render and behavior matches a single-provider project byte-identically
