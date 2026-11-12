# Proposal

## Why

Milestone notifications omit the originating project and total chain runtime, forcing users working across projects to open the app to identify them. Project Builder polish needs consistent, informative notifications without changing launch or delivery behavior.

## What Changes

- Give the five existing milestone notifications a shared localized title and secondary status/elapsed line, preserving event details, actions, durations and deduplication ids.
- Expose chain creation time from the existing database column; tolerate older payloads without that timestamp.
- Resolve project names from the existing client project map and compute static elapsed values, using the chain end timestamp for delivered/completed notifications.
- Cover defensive formatting, project isolation, event timing, localization and snapshot serialization with focused regression tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `milestone-launch-chain`: extend chain visibility/control with unified milestone toast presentation and additive creation timestamp compatibility.

## Impact

Changes remain in the builder server projection, client builder helpers/hook, the App composition call site and locale resources. Existing completion and progress message shapes are extended only through the nested snapshot; project names stay client-side. No migrations, dependencies, lifecycle changes, polling or live timers. All eight shipped locale key trees must remain in parity, including the required English and Spanish copy. The design names affected fixtures and narrow documentation updates.
