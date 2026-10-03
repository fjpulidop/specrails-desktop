## Why

Mission Relaunch posts an empty launch request to a mutable rail slot. Terminal settlement releases its specs, the default workflow becomes Implement, and a failed delivery can block its own retry with `pr_decision_pending`.

## What Changes

- Identify the original delivery or shared run when relaunching, using its persisted specs and launch options.
- Freeze validated launch configuration for new isolated and shared loop launches; reconstruct historical options only from recorded evidence.
- Replace an undelivered failed generation through the existing atomic supersession and rollback contract, keeping its checkout recoverable.
- Restore released assignments only after admission checks, reject reused rails, stale generations and delivered work that needs recovery.
- Prevent duplicate clicks and keep admission errors visible on the card.

## Capabilities

### New Capabilities
- `mission-rail-relaunch`: Relaunch the identified attempt with its original workflow, targets and engine, preserving generation safety.

### Modified Capabilities

None.

## Impact

Desktop delivery HTTP/runtime/store, loop launch persistence, additive project DB migration, mission decision card and focused tests. Core is unchanged.
