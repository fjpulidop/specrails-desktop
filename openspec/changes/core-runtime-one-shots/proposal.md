## Why

After conversational surfaces run on Core sessions (`core-sessions-conversational-surfaces`), Desktop still spawns provider CLIs itself for single-shot AI calls. Those are AI titles, file summaries, agent generation, proposals and setup steps. It does so through `server/providers/*` and `spawn-lifecycle`. That keeps a second provider layer alive: argv building, frame parsing, usage extraction, the Windows spawn traps and per-provider quirks are duplicated in Desktop and Core. The program's end state is Core as the only engine for agent work, so this layer has to go.

## What Changes

- Core gains a one-shot operation on the session host (an ephemeral session or a dedicated `run` request; decided in the design). It covers prompt, model, effort, structured output and the tool policy, and returns text plus normalized usage.
- Desktop migrates every one-shot caller onto it. Today these are:
  - mission and chat titles;
  - Code Explorer file summaries (`code/runtime/file-summary-generator.ts`);
  - agent generation (`agents/runtime/agent-generator.ts`);
  - spec proposals (`specs/runtime/proposal-manager.ts`) and spec launch helpers;
  - setup and framework steps that invoke a provider.
- Once no caller remains, remove `server/providers/*` (adapters, live sessions, registry) and the provider branches in `spawn-lifecycle`. Provider identity, model catalogs and capability descriptors then come from Core's `initialize`.
- Accounting reads Core's normalized usage everywhere. The estimation and missing-value semantics stay identical.

## Capabilities

### New Capabilities
- `core-one-shot-invocations`: one-shot AI calls through Core, with usage, timeouts, cancellation and a legacy fallback during the transition.

### Modified Capabilities
- `core-session-host`: the host serves one-shot invocations as well as sessions.

## Impact

- **Core**: a new host operation, driver support for one-shots, and the protocol and docs.
- **Desktop server**: every one-shot caller, then deletion of `server/providers/*` and its tests. This needs `npm run audit:source` and a careful check of dynamic loading and external contracts before deleting.
- **Desktop client**: provider and model catalogs read from the new source; there are no visible behaviour changes.
- **Packaging**: the bundled Core pin; Windows spawn handling moves entirely to Core.
- **Sequencing**: last phase of the Core agent-session program, after `core-sessions-conversational-surfaces`.
