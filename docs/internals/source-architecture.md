# Source boundaries and unused-code review

The application has six TypeScript entry points: the Express server, React UI,
demo UI, CLI, MCP bridge and local runner. Rust/Tauri, build scripts, static
resources, locale JSON and provider-loaded assets have their own entry points;
the TypeScript inventory does not classify those as unused.

## Persistence

`server/db.ts` is the stable public facade. Existing consumers and test mocks can
continue to import it. Implementations live under `server/db/`:

| Module | Responsibility |
| --- | --- |
| `connection.ts` | Open/secure/close-on-error the SQLite connection and initialize it |
| `migrations.ts` | Apply the existing ordered, numbered migration history |
| `types.ts` | Shared persistence inputs and connection type; no runtime imports |
| `jobs.ts` | Job lifecycle, durable admission, events, phases and transactional deletion |
| `activity.ts`, `stats.ts` | Read models for activity and aggregate statistics |
| `conversations.ts`, `proposals.ts`, `templates.ts` | Queries for their respective domains |
| `settings.ts` | Compatibility facade to the project-settings module |
| `telemetry.ts` | Telemetry blobs and summaries |

Repositories receive `DbInstance` explicitly. They must not open connections or
import the facade. Keep transaction ownership with the operation that needs
atomicity: job deletion still removes its dependent records in one transaction.
The extraction preserves every migration's SQL and ordering. Do not renumber
historical migrations when reorganizing source.

Project configuration now has a [ports-and-adapters module](../../server/modules/project-settings/README.md) with domain-owned types, use cases and a repository port. The legacy settings facade delegates to it. HTTP updates are atomic and validated before persistence.

Settings reads use one query for the six supported configuration keys instead
of six separately prepared queries. This reduces query work without changing
defaults or introducing a cache that could become stale.

## Queue collaborators

`QueueManager` owns orchestration and mutable execution state. Provider telemetry
environment construction lives in `providers/telemetry-env.ts`; project version
capability detection lives in `project-profile-support.ts`. The project registry
imports the capability probe directly instead of requiring the queue manager at
loop launch. Compatibility exports remain for existing queue consumers.

Queue and SMASH accounting share `util/distribute-int.ts`. Both use the same
largest-remainder calculation, including absent values and integer truncation.
Do not create another local copy of this accounting rule.

## Preventing unused locals

The server enables TypeScript `noUnusedLocals`, matching the existing client
policy. `npm run typecheck` and CI now reject unused imports and local
declarations. The cleanup removes copied router imports and seven unreferenced
private/local helpers or constants, plus unused destructured values and an
unread browser-manager field. Public callback parameters remain compatible.

## Reviewing unused source

Run `npm run audit:source`. It traverses static imports, re-exports, literal
`import()`/`require()` and import types from all six entry points. Test imports
are intentionally not application roots: a test alone does not make an obsolete
component a production dependency. `AUDIT_IMPORTERS=1 npm run audit:source` also
prints the importers of each candidate.

The report is a review aid, not a deletion command. It cannot prove absence of
reflection, filesystem loading, external consumers, aliases or generated entry
points. Check those, build configuration and references across the repository
before deleting a candidate. Nonliteral imports are listed for manual review.

Two intentional candidates remain:

- `server/modules/builder/runtime/blueprint-spec-fixtures.ts`: shared test fixture used by five suites.
- `server/modules/delivery/runtime/rail-launch-parser.ts`: protocol reference implementation used by the
  parser tests and a byte-parity contract with the active client parser.

The removed UI modules formed unreachable islands, including the old root/nav
layout, ticket view variants, template library, proposal modal and unused hooks.
Their exclusive tests were removed with them; shared suites remain. The unused
`ticket-broadcast.ts` helper and its exclusive describe block were also removed.
The active ticket router/watcher behavior retains its tests. The separator
component's unused Radix dependency was removed from the client manifest/lock.

## Scope and follow-up boundaries

This refactor does not claim every module is SOLID or that absence of unused
exports is proven. The queue, rail delivery, chat and runtime managers still have
large stateful lifecycles. Split those by execution/recovery/transport boundaries
only with lifecycle regression coverage; moving methods into arbitrary classes
would add indirection without establishing independent responsibilities.

No runtime-speed or bundle-size gain is claimed without measurement. The
concrete improvements here are fewer settings queries, one accounting algorithm,
separate persistence responsibilities and removal of unreachable source/tests.

## Removed production modules

Each of these had no path from any of the six application/demo entry points.
References were limited to the removed islands, their tests, stale mocks or
historical documentation.

- `client/src/components/ActiveJobCard.tsx`
- `client/src/components/AgentSelector.tsx`
- `client/src/components/AiEditComposer.tsx`
- `client/src/components/AiEditDiffView.tsx`
- `client/src/components/CollapsibleSection.tsx`
- `client/src/components/CommandGrid.tsx`
- `client/src/components/CostAwarenessMeter.tsx`
- `client/src/components/CreateTemplateDialog.tsx`
- `client/src/components/FeatureProposalModal.tsx`
- `client/src/components/HealthIndicatorBadge.tsx`
- `client/src/components/ModelCombobox.tsx`
- `client/src/components/ModelSelector.tsx`
- `client/src/components/Navbar.tsx`
- `client/src/components/ProjectHealthGrid.tsx`
- `client/src/components/ProjectHealthWidget.tsx`
- `client/src/components/ProjectNavbar.tsx`
- `client/src/components/RootLayout.tsx`
- `client/src/components/SessionAttachmentBar.tsx`
- `client/src/components/TabBar.tsx`
- `client/src/components/TemplateLibrary.tsx`
- `client/src/components/TicketGridView.tsx`
- `client/src/components/TicketListView.tsx`
- `client/src/components/TicketPostItView.tsx`
- `client/src/components/TicketsSection.tsx`
- `client/src/components/jira/JiraIntegrationCard.tsx`
- `client/src/components/ui/separator.tsx`
- `client/src/hooks/useProposal.ts`
- `client/src/hooks/useRails.ts`
- `client/src/hooks/useSectionPreferences.ts`
- `client/src/hooks/useSpecLauncher.ts`
- `client/src/pages/DesktopOverviewPage.tsx`
- `server/ticket-broadcast.ts`
