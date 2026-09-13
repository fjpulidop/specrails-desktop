## Context
Role instructions live in Core prompts.ts. Desktop already has global provider connections, atomic settings files and an authoritative Core CLI loader. Jobs persist a scoped configuration before launching Core.
## Goals / Non-Goals
Expose the existing role definition, editing and per-role reset for all providers. Keep output contracts and dynamic scope automatically assembled. No per-provider duplication or modification of running jobs.
## Decisions
Core supplies the default catalog through its CLI, avoiding a stale Desktop copy. An optional rolePrompts map is validated in Core and both JSON schemas. Desktop stores only overrides globally, resolves effective defaults at job admission and freezes them in desktop-runtime-config.json. Resume reads that file unchanged. Tabs retain unsaved edits across roles; explicit Save applies all edits and Discard reloads the last saved state. Errors remain visible and do not discard text.
## Local reference patterns
Desktop RuntimeProviderConnections uses fetch, translated state feedback and fieldsets; agent-runtime-settings.ts provides atomicJson. GlobalSettingsPage hosts the settings section. Core roleInstructions assembles dynamic evidence and output contracts; graph/nodes.ts builds each role prompt. Core-host includes config in frozen input.
## Risks / Trade-offs
Custom instructions can reduce quality; enforce existing runtime gates and keep structured contracts. Unknown or blank roles and overlong definitions are rejected. Missing Core catalog makes editing unavailable rather than displaying guessed defaults. Older saved jobs keep their prior config and unchanged default wording.
