# agents

This module owns the agents capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/agent-defaults.ts](runtime/agent-defaults.ts)
- [runtime/agent-catalog.ts](runtime/agent-catalog.ts): provider-native custom agent discovery.
- [runtime/agent-role-descriptor.ts](runtime/agent-role-descriptor.ts): pure custom-agent to Core role projection.
- [runtime/agent-refine-db.ts](runtime/agent-refine-db.ts)
- [runtime/agent-refine-manager.ts](runtime/agent-refine-manager.ts)
- [runtime/agent-store.ts](runtime/agent-store.ts)
- [runtime/profile-manager.ts](runtime/profile-manager.ts)
- [runtime/profiles-router.ts](runtime/profiles-router.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/agents` and any affected consumers.

## Custom roles for Core workflows

Native `custom-<role-id>` agent documents also provide defaults for the Core role
`<role-id>`. IDs must be lowercase and cannot shadow architect, developer,
reviewer or fixer. Existing Markdown bodies remain valid; YAML frontmatter can
declare `access` (`read` by default), `artifacts` (`none` by default), an explicit
`openspecSkill`, and `engine` provider/model/effort/thinking/maxTurns/escalation.
Instructions never implicitly grant write access. Escalation requires a distinct
model or effort and a base model.

The catalog exposes `roleId`, `runtimeRoleDefaults`, or `runtimeRoleError` for
invalid documents. These are file defaults: explicit project runtime roles and
prompts take precedence. Runtime settings validate the merged configuration and
the bridge freezes it for each launch; resume uses that frozen configuration.
Native discovery stays in the agents module and the runtime consumes its focused
public subpaths, avoiding a reverse dependency from agents to agent-runtime.
