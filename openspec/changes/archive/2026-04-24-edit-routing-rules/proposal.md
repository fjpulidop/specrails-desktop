## Why

Routing rules in agent profiles can be added, reordered, deleted, and have their target agent changed — but **tags on an existing rule cannot be edited**. Today the only workaround is delete + re-add, which loses position and feels broken. With zero users on the current release, it is cheap to add proper edit now and simultaneously lock down the core catch-all rule (`default: true` → `sr-developer`) so it can never be retargeted or deleted — the pipeline depends on that fallback always existing.

## What Changes

- Add tag editing to existing routing rules via a pencil-icon hover action in `RoutingRow`.
- Reuse `RoutingRuleDialog` for both add and edit flows (new `mode: 'add' | 'edit'` + `initial` prop).
- **BREAKING (schema-level, zero-user impact)**: the `default: true` routing rule is now pinned to `agent: 'sr-developer'`. Its target agent is no longer configurable and the rule cannot be deleted from any profile. Server validator enforces this; UI hides the corresponding controls.
- The non-default rules remain fully editable (tags + agent + position + delete) on every profile type, including `default` and `project-default`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `project-agent-models`: routing rule editing semantics — tag-level edit added; default catch-all rule locked to `sr-developer`.

## Impact

- `client/src/features/agents/components/RoutingRuleDialog.tsx` — gain edit mode
- `client/src/features/agents/components/ProfileEditor.tsx` — new `setRoutingRuleTags` handler; guards on default rule
- `server/modules/agents/runtime/profile-manager.ts` — `validateStructural` rejects default rule with agent ≠ `sr-developer`
- `server/schemas/profile.v1.json` — (optional) tighten default rule agent; may skip and rely on structural check since schema is shared with specrails-core
- Tests: `ProfileEditor.test.tsx`, `profile-manager.test.ts`
- No DB migration, no WS protocol change, no user data migration (zero users on 1.39.0 as of 2026-04-24)
