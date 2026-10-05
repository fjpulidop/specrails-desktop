## Why

Relaunch reconstructs an empty workspace-selection map for deliveries that used registered workspace defaults. Normal launch validation rejects that generated map before starting the job. Removing a repository from a mission launch card can generate the same invalid payload.

## What Changes

- Preserve absence of workspace narrowing when reconstructing a delivery with no recorded workspace selections.
- Omit selection maps after frontend repository projection leaves no entries.
- Retain explicit narrowing and reject invalid selections instead of silently expanding scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mission-rail-relaunch`: Preserve optional workspace defaults and explicit narrowing across source-bound relaunch and launch-card repository edits.

## Impact

Desktop delivery reconstruction, launch-card payloads, focused route and UI tests, and mission-rail documentation. No Core, database or public validation-contract change.
