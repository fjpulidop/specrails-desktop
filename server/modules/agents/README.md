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

## Mission archive persistence

Conversations expose nullable `archivedAt` mapped from `archived_at`. Archive and
unarchive return null for unknown or trashed IDs. Archive keeps its first stamp
on retries; unarchive is idempotent. Both preserve history, pins, sessions and
`updated_at`. Listing defaults to Active, accepts `archiveScope` (`active`,
`archived`, `all`) and `limit` (default 100), and always excludes trash. The
legacy numeric limit argument remains supported; ordering stays latest activity
first. Archive has no expiry and is independent of the 30-day trash window.

Soft delete requires archive for non-trashed missions. Both HTTP DELETE variants
reject active rows with 409 `NOT_ARCHIVED` before stopping work. Archived Delete
keeps history and the first `deleted_at`; Undo clears only `deleted_at`, returning
the mission to Archived. Legacy trash with no archive stamp can still be restored
or hard-purged and expires at exactly 30 days. Hard-delete persistence remains
unconditional for the existing purge owner. Unknown soft DELETE is idempotent;
unknown permanent DELETE returns 404.
