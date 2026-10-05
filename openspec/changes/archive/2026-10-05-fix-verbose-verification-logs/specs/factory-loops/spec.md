## ADDED Requirements

### Requirement: Verbose verification remains readable

Desktop SHALL bound the human-readable projection of verbose verification output, preserving representative failure diagnostics, final test summaries and recorded command outcomes. It SHALL indicate omitted output and preserve the original runtime evidence path without changing command execution, verification validity or workflow settlement.

#### Scenario: Successful Jest command emits a warning flood
- **WHEN** a successful verification command emits tens of thousands of console stack frames and passing-suite lines
- **THEN** the readable rail log contains bounded output and the final test totals
- **AND** omitted output is explicitly indicated while original runtime events remain unchanged

#### Scenario: A real failure follows verbose output
- **WHEN** a failed command emits a compiler or assertion error after extensive warning output
- **THEN** the readable projection retains representative error facts and the recorded failing outcome
- **AND** full retained evidence remains available through the existing evidence interface

#### Scenario: Verification streams repeat or interleave
- **WHEN** separate commands or later verification attempts produce output
- **THEN** their presentation state does not hide another stream's result or carry an earlier suppression mode into a later command
- **AND** when the runtime supplies an attempt ID, delayed readable diagnostics and summaries remain associated with that attempt in persisted and live views

### Requirement: Log retention preserves workflow structure

The client SHALL preserve recorded loop lifecycle boundaries while bounding rendered job output. Invisible raw verification events SHALL NOT displace readable output or lifecycle markers; persisted evidence SHALL remain unaffected.

#### Scenario: Live output exceeds the display limit
- **WHEN** a live loop produces more output events than the display limit
- **THEN** its retained view still includes recorded step boundaries and completion markers
- **AND** the view indicates omitted readable output when applicable
