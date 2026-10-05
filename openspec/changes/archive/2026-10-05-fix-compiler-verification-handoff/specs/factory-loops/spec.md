## ADDED Requirements

### Requirement: Compiler failures remain actionable in correction handoffs

Implement SHALL pass representative file-located compiler errors from a failed host command to the fixer in bounded failure summaries, retaining the command's actual exit code and full-evidence reference. A lint report with zero errors SHALL NOT displace the compiler errors as the failure summary. This diagnostic handoff SHALL preserve candidate fingerprint validation and unchanged-correction termination.

#### Scenario: TypeScript errors are surrounded by warning-only lint output
- **WHEN** a mandatory command prints a warning-only lint report and file-located TypeScript errors amid lengthy output, then exits nonzero
- **THEN** the fixer's structured failure summary contains compiler diagnostics rather than the zero-error lint report
- **AND** the prompt retains the command's exit code and evidence reference

#### Scenario: The fixer cannot repair a compiler failure
- **WHEN** the fixer makes no candidate changes after receiving the compiler error evidence
- **THEN** Implement terminates after that correction without repeating verification, invoking review or archiving the failed candidate
