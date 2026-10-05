## Why

Core's bounded verification summary can select a lint report with zero errors while omitting file-located TypeScript errors from the same failed command. The Implement fixer needs the actual compiler failure even when surrounding output is long.

## What Changes

- Add a paired Desktop/Core regression for compiler diagnostics passed to the configurable Implement fixer.
- Specify that warning-only lint summaries do not displace compiler failures; preserve failure exit codes and bounded evidence.
- Keep unchanged-correction termination, candidate fingerprints and mandatory verification intact.

## Capabilities

### New Capabilities

### Modified Capabilities

- `factory-loops`: actionable compiler failure evidence in the Implement correction handoff.

## Impact

Desktop's paired factory test and narrow documentation; Core owns the diagnostic classifier and excerpt correction in a companion PR. No runtime JSON shape, dependency installation or project-specific behavior changes.
