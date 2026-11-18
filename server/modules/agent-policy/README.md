# Agent policy

A Claude `PreToolUse` hook that denies a short list of destructive or
credential-touching tool calls inside agent turns (Claude runs with
`--dangerously-skip-permissions`; hooks still run). Feature guide:
[agent policy and continuity](../../../docs/internals/agent-policy-and-continuity.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Deny rules (non-git) and run-directory reasoning | [domain/rules.ts](domain/rules.ts) |
| Git rules (shared with the app's push path) | [../../git-guardrails.ts](../../git-guardrails.ts) |
| Shell reading (separators, `cd`, wrappers, nested scripts, heredocs) | [domain/shell.ts](domain/shell.ts) |
| Denial marker and its recognition in streams | [domain/denial.ts](domain/denial.ts) |
| Merging our hook into Claude settings (owned entries only) | [domain/settings.ts](domain/settings.ts) |
| Spooled denial format | [domain/report.ts](domain/report.ts) |
| Hook process contract, fail-open policy, git facts from files | [hook/policy-hook.ts](hook/policy-hook.ts), [hook/main.ts](hook/main.ts) |
| Script on disk, mission-cwd settings, shared `settings.local.json` writer | [adapters/install.ts](adapters/install.ts) |
| Spool drain and placement in a project's audit | [adapters/spool.ts](adapters/spool.ts), [adapters/ingest.ts](adapters/ingest.ts) |

Worktree installation lives in [worktree-overlay.ts](../../worktree-overlay.ts)
(managed `.claude/settings.local.json`), fed by `resolveOverlaySources`
(`delivery/runtime/isolated-worktree.ts`). Composition: `server/index.ts`
(script at startup, spool drain), `missions/runtime/agent-chat-manager.ts`
(mission cwd before each Claude turn).

## Invariants

- Never write into a person's checkout; only the app-owned mission cwd and
  isolated worktrees (as an overlay-owned copy, never through a link).
- Only touch hook entries whose command names `specrails-policy-hook`; every
  other settings key (the connectors' `deniedMcpServers`) is kept.
- The hook never answers `allow`; it fails open except for deny-list shapes.
- `hook/main.ts` is bundled, never imported by the server. After changing
  anything it reaches, run `npm run build:policy-hook` (a test fails otherwise).

## Verify a change

```bash
npx vitest run server/modules/agent-policy server/git-guardrails.test.ts server/worktree-overlay.test.ts server/modules/audit
node scripts/build-policy-hook.mjs --check
npm run typecheck && npm run audit:architecture
```

## Reviewed public entry points

- [index.ts](index.ts)
- [domain/denial.ts](domain/denial.ts)
