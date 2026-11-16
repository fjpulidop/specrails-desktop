# Proposal

## Why

Continuing a blueprint previously offered no choice of the AI generating the next milestone. The implemented change lets users save a usual provider, model and reasoning effort, use a one-milestone exception, and separately choose how M1 executes.

## What Changes

- Add project-scoped generation preferences and a compatible installed-provider catalog, exposed through Blueprint settings routes and sidebar controls.
- Capture the chosen provider/model/effort on milestone conversations and forward supported effort to native generation turns without changing ordinary chat or day-0 defaults.
- Offer an independent execution selection before M1 from the completed Builder and sidebar; validate and freeze it for chain rails, retries and resume, rejecting conflicting loop engine configuration.
- Keep Builder visible when project creation announces a mission, so the M1 controls remain accessible.
- Copy missing OpenSpec configuration into worktrees without sharing specs or changes, and normalize Engine 2 structured failures for read-only diagnosis.
- Add regression coverage, localized control text in all eight builder locales, module guidance and source-map entries.

## Capabilities

### New Capabilities

- `blueprint-generation-settings`: persistent generation defaults, compatible catalogs and one-milestone overrides.

### Modified Capabilities

- `milestone-lifecycle`: M1 selection in both launch surfaces and selected generation configuration on project milestone conversations.
- `milestone-launch-chain`: durable explicit execution engines across chain retries and subsequent rails, with strict loop conflict rejection.
- `builder-mode-agent-panel`: mission arrival refresh preserves the active Builder.
- `rail-parallel-isolation`: isolated local OpenSpec configuration overlay.
- `programmatic-agent-runtime`: diagnosis accepts Engine 2 failure representations.

## Impact

React Builder controls, missions context and project API base selection; project router and chat creation; conversation spawning; milestone chain persistence and rails launch; worktree overlay and runtime diagnosis. Migration 92 adds nullable `engine_config` to `milestone_launch_chains`; generation settings reuse project `queue_state`. Existing provider adapters and selector primitives are reused; no dependencies are added. This document derives the existing diff against `af2daab8829dc5933d31fe01b8d47ec11123d24f`, not additional implementation work.
