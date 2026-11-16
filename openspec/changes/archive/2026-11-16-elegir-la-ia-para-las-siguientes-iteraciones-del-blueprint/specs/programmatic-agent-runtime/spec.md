# Spec Delta

## ADDED Requirements

### Requirement: Diagnosis accepts Engine 2 failures
Read-only diagnosis SHALL accept legacy stepId/text errors and Engine 2 nodePath/structured code-message errors. It SHALL project the latest eight failures with stepId and error text bounded to the last 6000 characters. If run-level error is absent, repetition detection SHALL compare against the latest failure for the next step. Reading diagnosis SHALL not resume execution.

#### Scenario: Structured repeated architect error
- **WHEN** two failed architect attempts use nodePath and the same structured invalid_role_output error with no run-level error
- **THEN** diagnosis returns stepId architect, joined code/message text, repeatFailureCount 2 and repair_before_retry for the failed run, without executing or creating recovery records

#### Scenario: Legacy failure compatibility
- **WHEN** failures already contain stepId and text errors
- **THEN** diagnosis retains their existing text projection and repetition behavior
