## Why

Core implementations repeat verification, disagree across provider workflows, and cannot reliably reuse completed phases or locate multi-repository artifacts. Desktop also resolves multiple Core installations inconsistently: an update can appear to revert after restart, and the Core 5 lifecycle is incompatible with its old enrichment setup.

## What Changes

- Establish explicit execution context, phase checkpoints, evidence validity and host ownership for implement, batch and retry across Claude, Codex, Gemini and Kimi.
- Correct confidence/archive ordering, blocked-phase recovery and candidate verification; avoid repeating verified unchanged work.
- Integrate the Core 5 deterministic installation lifecycle in Desktop.
- Resolve installed/runtime/framework/latest versions consistently, prevent silent downgrades, make update completion verifiable and preserve the previous usable installation on failure.
- Add regression tests for provider execution contracts, relocated multi-repo workspaces, updates and restart behavior.

## Capabilities

### New Capabilities
- `core-execution-contract`: Shared provider lifecycle, explicit repository/artifact context and reusable verification evidence.
- `core-update-consistency`: Accurate, restart-stable Core selection, update and framework reporting in CLI and Desktop.

### Modified Capabilities

None.

## Impact

This coordinated change spans specrails-core runtime/templates/installer and specrails-desktop setup/version resolution/loop integration/Settings. Existing Desktop branch changes and custom project artifacts must be preserved. No package release, global installation replacement or live project migration is performed by development tests.
