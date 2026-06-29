# loop-constants-guardrails Specification

## Purpose
TBD - created by archiving change loop-template-library. Update Purpose after archive.
## Requirements
### Requirement: Guardrails Built-In Constant

The constants library SHALL provide a read-only built-in constant named `GUARDRAILS`, referenced as `{{const:GUARDRAILS}}`, whose value is the canonical hardened anti-gaming contract. The contract SHALL, at minimum, forbid: modifying the check command or exit criteria to force success; skipping, disabling, or bypassing checks; weakening, deleting, or skipping tests or replacing real assertions with always-pass tests; and patching tests instead of fixing production code. It SHALL also direct the agent to stop and report blockers instead of gaming metrics when stuck. The constant SHALL resolve at run time wherever its token appears.

#### Scenario: Guardrails resolves at run time

- **WHEN** a step prompt containing `{{const:GUARDRAILS}}` is resolved for a run
- **THEN** the token SHALL be replaced with the hardened anti-gaming contract text

#### Scenario: Guardrails is listed as a read-only built-in

- **WHEN** the constants library is listed
- **THEN** `GUARDRAILS` SHALL appear among the built-in constants
- **AND** it SHALL be marked as a built-in (read-only)

### Requirement: Guardrails Cannot Be Redefined Or Deleted

Because `GUARDRAILS` is a built-in tamper-resistance contract, the app SHALL reject any attempt to create a custom constant named `GUARDRAILS` and SHALL NOT allow the built-in to be edited or deleted, consistent with the existing built-in verification sentinels.

#### Scenario: Creating a custom GUARDRAILS is rejected

- **WHEN** the user attempts to create a custom constant named `GUARDRAILS`
- **THEN** the creation SHALL be rejected as a reserved name

#### Scenario: Built-in guardrails is not user-editable

- **WHEN** the constants are presented for management
- **THEN** the `GUARDRAILS` built-in SHALL be presented as read-only
- **AND** no delete or edit affordance SHALL mutate its value

