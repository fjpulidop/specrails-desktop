# Verification — mission process observability

Verified on macOS, 2026-09-06, on `codex/multi-repo-projects`.

## Outcome and regression coverage

- Server: **65 files / 1,642 tests passed**. Covers mission managers, MCP, providers, process admission, project lifecycle, background REST routes, retained logs, ownership, retry and shutdown. Command:

  ```sh
  npx vitest run server/agent server/mcp server/providers server/transient-children.test.ts server/transient-children.integration.test.ts server/background-process-control.test.ts server/background-process-flow.test.ts server/project-router-background-processes.test.ts server/project-registry.test.ts server/project-router.test.ts server/process-admission.test.ts server/desktop-db.test.ts server/spawn-lifecycle.test.ts server/interactive-job-session.test.ts server/util/cli-prompt.test.ts --maxWorkers=2 --reporter=dot
  ```

- Client: **7 files / 173 tests passed**, including scoped state reconciliation, delayed WebSocket events during Stop, timed-out requests, missed terminal events, conversation switching, process chip controls, modal polling/cancellation, filtered exports, partial lines and locale parity. Command from `client/`:

  ```sh
  npx vitest run src/context/__tests__/BackgroundProcessesContext.test.tsx src/lib/__tests__/background-processes-api.test.ts src/components/__tests__/BackgroundProcessLogsModal.test.tsx src/components/agent-chat/__tests__/agent-background-process-chips.test.tsx src/components/agent-chat/__tests__/agent-chat.test.tsx src/components/agent-chat/__tests__/AgentModeSurface.test.tsx src/lib/__tests__/i18n.test.ts --maxWorkers=2 --reporter=dot
  ```

- `npm run typecheck`: passed for server, CLI, MCP bridge and client.
- `npm run build`: passed for server, client and CLI. Vite reports its non-blocking large-chunk advisory.
- `cargo check --offline --manifest-path src-tauri/Cargo.toml`: passed.
- `OPENSPEC_TELEMETRY=0 openspec validate mission-process-observability --strict`: passed.
- `git diff --check`: passed.

## Real process evidence

The server suite includes disposable POSIX fixtures, not just mocked child-process events:

1. A shell exits while its child ignores SIGTERM. The registry stays `stopping`, escalation remains armed, the child and its group disappear, and shutdown drain waits for confirmation.
2. A wrapper exits with code 7, leaving a resistant child. Automatic cleanup removes the descendant and retains the wrapper's original `failed` outcome and exit code.
3. A mission MCP call starts an actual HTTP application. Scoped REST logs include partial stdout/stderr without newlines. A stale execution identity is refused without stopping the server. The correct stop reaches `killed`, then the test binds the same port again to prove the app released it. Terminal logs and repeated stop remain available.

Fixtures clean up only their own groups and temporary files. No user application or paid model execution is required.

## Browser inspection

The actual React chip and inspector were exercised against fixture API responses at 1440×960 and 800×800, both at device scale factor 2. Both passed:

- Opening the inspector without stopping the application.
- Search and stdout/stderr filtering; copying and downloading the visible view.
- Pausing updates without interrupting the process; stable partial-line replacement.
- A 2,500-line burst bounded to at most 2,000 rendered lines and 512 KiB of retained text.
- Retention/read errors with retry; stop preserving execution identity.
- Closing cancels polling; no page errors or horizontal overflow.

Temporary evidence is in `/tmp/specrails-background-logs-smoke-report.json` and `/tmp/specrails-background-logs-{1440,800}-{live,filtered,retention-error,stopped}.png`. The fixture page, Vite instance and test browser were cleaned up.

## Practical limits

Windows identity queries and taskkill behavior are covered by simulated OS tests, including creation-time checks, reused PIDs, query failures and retry. A Windows machine was not available for a real process smoke test. Neither Windows tree discovery nor POSIX groups claim containment of applications that deliberately detach into independent services.

Logs are bounded in memory: 2,000 lines of 4,000 characters per execution, 32 finished executions for ten minutes, and a 512 KiB inspector view. They are not persisted across restarts. The UI retains terminal chips for two minutes and an already-open inspector keeps its last snapshot.

User-facing behavior and operational guidance are documented in [mission-processes.md](../../../docs/mission-processes.md).
