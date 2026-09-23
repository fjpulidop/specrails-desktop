## Problem

The hub install wizard provisions `sr-merge-resolver` as part of its default agent set alongside the mandatory pipeline trio (`sr-architect`, `sr-developer`, `sr-reviewer`). Three surfaces treat it as a "core" agent that cannot be deselected:

1. `client/src/components/AgentSelector.tsx` — `CORE_AGENTS` set includes `sr-merge-resolver`; the agent renders with a lock icon and is immune to toggle/deselect actions.
2. `client/src/components/SetupWizard.tsx` — `handleInstall` forces every agent in `CORE_AGENTS` back into `selectedWithCore` before building the install-config payload, so even if `AgentSelector` were fixed, the wizard would re-add it.
3. `server/providers/claude-adapter.ts` and `server/providers/codex-adapter.ts` — `baselineAgents()` returns a four-element list that includes `sr-merge-resolver`, making it a hard baseline requirement for `ProfileManager` validation.

A secondary surface is `server/modules/agents/runtime/profiles-router.ts` (`POST /profiles/migrate-from-settings`), which hard-codes a four-agent baseline when seeding an initial profile from existing frontmatters. This is a legacy migration path, not the wizard flow, but it shares the same conceptual error.

The practical consequence: every new installation gets `sr-merge-resolver.md` placed in `.claude/agents/`, the generated default profile's `agents[]` contains four entries, and users who look at their `agents/` directory see an agent they did not select and cannot remove through the wizard UI.

`sr-merge-resolver` is no longer part of the mandatory pipeline. Treating it as a core artifact adds noise, inflates the default profile, and misleads new users into thinking merge-resolution is a required pipeline phase.

## Proposed Solution

Remove `sr-merge-resolver` from every hub-side surface that treats it as mandatory:

- **`client/src/components/AgentSelector.tsx`** — remove `sr-merge-resolver` from `CORE_AGENTS`. It remains in `ALL_AGENTS` (category `Utilities`) so it is still visible and selectable in the wizard.
- **`server/providers/claude-adapter.ts`** — remove `sr-merge-resolver` from `baselineAgents()`. Return the three-element list `['sr-architect', 'sr-developer', 'sr-reviewer']`.
- **`server/providers/codex-adapter.ts`** — same change as above for the codex provider.
- **`server/modules/agents/runtime/profiles-router.ts` (`migrate-from-settings`)** — update the hard-coded `baseline` array and the `pinnedLast` / ordering logic to reflect the trimmed trio. `sr-merge-resolver` is included in the profile if it exists in the project's `.claude/agents/`, but it is no longer a required baseline agent.

The `SetupWizard.tsx` change is implicit: once `CORE_AGENTS` no longer contains `sr-merge-resolver`, the `handleInstall` guard (`selectedWithCore = [...new Set([...CORE_AGENTS, ...cfg.selectedAgents])]`) automatically stops forcing it into the payload.

No server-side `setup-manager.ts` changes are needed — the wizard already passes the selected/excluded lists through to `specrails-core`; the fix is entirely in what gets included in that list.

## Out of Scope

- Any changes to `specrails-core` source or its install scripts.
- Deleting or deprecating `sr-merge-resolver` as an agent (it stays in the catalog and can be added by users at any time).
- Removing `sr-merge-resolver` from existing installations — no migration is run.
- Changes to the Agents Catalog tab UI or the ProfileEditor pin-last behavior for `sr-merge-resolver` (aesthetic UI polish is a separate concern).
- `server/modules/agents/runtime/profiles-router.ts` `migrate-from-settings` ordering logic for `sr-merge-resolver` when it is present in a project — it may still pin last as a courtesy, but it is no longer required to exist.
