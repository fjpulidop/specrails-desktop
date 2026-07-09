## ADDED Requirements

### Requirement: OpenSpec Quick Command Context
The magic-command catalog and interpolation layer SHALL provide enough structured context for OpenSpec lifecycle prompts to continue a known OpenSpec change when `SDD Quick (OpenSpec)` is launched from a linked local ticket.

#### Scenario: OpenSpec change token resolves from ticket metadata
- **WHEN** a loop prompt references the whitelisted OpenSpec change field for a local ticket
- **THEN** the interpolation layer SHALL resolve it from structured ticket metadata
- **AND** unknown or absent values SHALL collapse to an empty string rather than leaking raw template tokens

#### Scenario: Metadata exposure is whitelisted
- **WHEN** a ticket contains arbitrary metadata fields
- **THEN** the interpolation layer SHALL NOT expose all metadata automatically
- **AND** only approved fields needed by the OpenSpec quick workflow SHALL be available in prompts

### Requirement: OpenSpec Command Namespace Preservation
OpenSpec quick workflows SHALL continue to use provider-aware `opsx:*` command expansion and SHALL NOT emit `/specrails:*` commands for OpenSpec artifact lifecycle steps.

#### Scenario: SDD Quick uses opsx commands
- **WHEN** `SDD Quick (OpenSpec)` expands its lifecycle prompts
- **THEN** OpenSpec artifact steps SHALL expand through `opsx:ff`, `opsx:apply`, and `opsx:verify`
- **AND** they SHALL preserve the existing provider-native or fallback behavior of those commands
