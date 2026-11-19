# machine-installs

"Ask once" for a machine-wide install a run needs (Core capability `machineInstalls`, contract 5.17).
A run never installs anything machine-wide itself: the [agent policy](../agent-policy/README.md)
denies it (`machine-install`). When only such an install provides a missing tool, Core pauses the run
on ONE ordinary question interrupt (`data: { kind: 'machine-install', command, tool }`, `options`
`install` / `self`). It reaches the person through the normal question path (inbox, live board,
run window). On **Install** the host runs the exact command itself, outside the run, with its output in
the run log, and answers Core `installed`; the node runs again and the run continues by itself. On
**I'll do it myself** it answers `declined` and the run stops on the precise blocker (its
`requiredAction` names the command). The approval is remembered by the normalized command in the app
database, so the same install is never asked again, in any project. Settings ▸ Remembered installs
lists and revokes approvals.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Allowlist of runnable installer shapes, the shell-free word splitter, Core's answer vocabulary | [domain.ts](domain.ts) (pure) |
| Ask / auto-answer / remember / revoke use cases and their ports | [application.ts](application.ts) |
| Running an approved argv (no shell, stdin closed, time limit, tree kill) | [adapters/process.ts](adapters/process.ts) |
| Approvals table (`machine_install_approvals`, desktop migration 41) | [adapters/sqlite.ts](adapters/sqlite.ts) |
| `GET` / `DELETE /api/machine-installs` | [adapters/http.ts](adapters/http.ts), mounted by [desktop-router.ts](../../desktop-router.ts) |

Composition: `server/project-context-loops.ts` binds the use cases to each project's `LoopRunManager`
(`machineInstalls` option); `runDefinitionLoop` (`loops/runtime/loop-definition-run.ts`) asks them to
auto-answer a pending question, to turn the person's choice into Core's answer, and, after a restart,
to answer a question this process did not see pause. The Implement recipe sends `machineInstalls: 'ask'`
to write roles and `verify` only when Core advertises the capability.

## Invariants

- Only a command `parseInstallCommand` accepts is ever run: one allowlisted installer and verb, plain
  package names, allowlisted flags, no shell metacharacters, spawned as argv. `sudo`, system package
  managers (apt, dnf, port, …) and anything else are refused (`refused: …`): the person runs them.
- Nothing changes on the machine without the person's Install, now or earlier for the same exact command.
- Choosing an option never runs anything for a question that is not a machine-install question.
- Project-local installs (`npm install`, a `.venv`, `npx`, Playwright browsers) are Core's own
  environment repair and never reach this module.

Run `npx vitest run server/modules/machine-installs server/modules/agent-policy`.
