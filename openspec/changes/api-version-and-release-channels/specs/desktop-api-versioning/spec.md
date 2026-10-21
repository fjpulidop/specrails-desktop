## ADDED Requirements

### Requirement: Every API response carries the API version

The server SHALL set `X-Specrails-Api-Version: <API_VERSION>` (currently `1`) on every response whose
path starts with `/api`, including public routes, project-scoped routes, authentication failures and
unknown routes, and SHALL expose the header to allowed CORS origins. `GET /api/health` SHALL include
`apiVersion` without changing its existing fields.

#### Scenario: Desktop and project-scoped routes are stamped

- **WHEN** a client calls `GET /api/settings` or `GET /api/projects/:id/jobs`
- **THEN** the response carries `X-Specrails-Api-Version: 1`

#### Scenario: Rejected requests are stamped

- **WHEN** a request to `/api/settings` has no token, or targets an unknown `/api` path
- **THEN** the 401 or 404 response still carries `X-Specrails-Api-Version: 1`

### Requirement: API metadata route

`GET /api/meta` (authenticated) SHALL return `apiVersion`, `appVersion`, `coreVersion` (the Core in
use), `contractSchemaVersion`, `channel` and `updateManifestUrl`. Unknown values SHALL be `null`;
the set of keys SHALL NOT change when Core information is unavailable.

#### Scenario: Metadata reports versions and channel

- **WHEN** the app runs Desktop 2.64.2 with Core 6.6.5, contract schema `5.2`, on the stable channel
- **THEN** `/api/meta` returns `apiVersion: 1`, those versions, `channel: "stable"` and the stable manifest URL

#### Scenario: Core compatibility cannot be read

- **WHEN** reading the Core contract fails
- **THEN** `/api/meta` still answers 200 with the same keys and `null` for unknown values

### Requirement: Written versioning and deprecation policy

The API reference SHALL state that additive changes keep the version, that `apiVersion` is bumped only
on breaking changes, and that deprecated routes or fields are announced under "Deprecations" in the
CHANGELOG, recorded in a deprecation ledger and kept for at least two minor releases.

#### Scenario: A field is deprecated in 2.65.0

- **WHEN** a field is deprecated in 2.65.0
- **THEN** it is listed in the ledger and the 2.65.0 CHANGELOG under "Deprecations", and it is not removed before 2.67.0
