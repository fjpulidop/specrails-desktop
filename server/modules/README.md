# Server capability modules

Each capability owns its runtime coordination, stores and adjacent tests. The
[reviewed manifest](boundaries.json) records every production file, its imports
and its externally consumed subpaths. Explicit subpaths keep consumers from
initializing unrelated adapters through a catch-all barrel.

Use pure domain/application cores where policy changes independently of effects.
Project settings, execution accounting/budgets/recovery, delivery policy and
conversation recovery expose those boundaries. The architecture test has fixed
core allowlists independent of manifest generation. Runtime code is explicitly
effectful; placing it in a capability does not claim it is infrastructure-free.

The delivery decision workflows additionally have an acyclic dependency guard.
Existing SQLite transactions, provider strategies, operation leases and durable
outboxes retain their ownership and failure contracts.

Server startup/project-route composition, common protocol types, database
migrations, platform/resource-location adapters and existing providers/Jira/
plugins/mobile/MCP modules keep their established entry points outside this tree.
Those are shared infrastructure or already cohesive subsystems, not unassigned
feature code.

Validate with `node scripts/audit-server-modules.mjs --check` and
`npx vitest run server/modules/architecture.test.ts`. After reviewing an intended
boundary change, regenerate with `node scripts/audit-server-modules.mjs --write`
and update the owning module guide.
