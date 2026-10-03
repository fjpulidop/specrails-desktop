## ADDED Requirements

### Requirement: Implement corrections require candidate progress

The configurable Implement factory SHALL stop an automatic correction that leaves the actual candidate unchanged after either rejected review or failed host verification. Passing host checks SHALL NOT bypass that progress gate. An implementation accepted on its first review SHALL NOT require an artificial diff.

#### Scenario: Rejected review and unchanged fixer
- **WHEN** host checks pass, review rejects the candidate and the fixer makes no changes
- **THEN** Implement SHALL stop after that correction without repeating host checks or review
- **AND** its failure diagnostics SHALL retain the current review and fixer diagnosis

#### Scenario: Policy threshold rejects an otherwise approved review
- **WHEN** a reviewer reports approval but a required aspect score is below its threshold and correction makes no changes
- **THEN** the original acceptance policy SHALL remain enforced
- **AND** the fixer SHALL receive the threshold policy and current scores
- **AND** the run SHALL stop instead of repeating the green verification commands

#### Scenario: Review repair changes the candidate
- **WHEN** the fixer changes the candidate to satisfy a rejected obligation
- **THEN** Implement SHALL rerun host verification and review before archive

### Requirement: Implement bounds automatic correction attempts

The built-in configurable Implement recipe SHALL permit at most three automatic fixer turns per frozen plan, including corrections that modify files without satisfying review. It SHALL persist the counter in scoped workflow state and report exhaustion with the current diagnostics before hitting the global node-visit ceiling.

#### Scenario: Changing corrections never satisfy review
- **WHEN** each correction changes files but the required review remains rejected
- **THEN** Implement SHALL stop after three fixer invocations
- **AND** it SHALL NOT archive or request a fourth automatic correction

### Requirement: Readable runtime failures include durable reasons

Desktop SHALL include bounded durable completion reasons in the readable workflow failure log when Core emits them without a message. It SHALL preserve the current runtime failure and verification semantics.

#### Scenario: Correction stops with a completion reason
- **WHEN** Core emits workflow failure with correction diagnostics in completion reasons
- **THEN** the readable log SHALL display those diagnostics instead of only an unqualified workflow_failed event
