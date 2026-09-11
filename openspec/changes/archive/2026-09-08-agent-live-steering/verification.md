# Verification: agent-live-steering

## Contract coverage

| Requirement | Implementation | Evidence |
|---|---|---|
| Deliver during execution | Claude stream-json with UUID receipt; Codex app-server turn/steer with expectedTurnId; exclusive MCP fallback for other transports | Native protocol tests, `server/agent-native-steering.test.ts`, `server/agent-native-transports.test.ts` (real manager + real transports) and MCP manager integration use simulated child processes; 10 emitted Codex frames validate against locally generated 0.153.4 JSON Schema |
| Preserve actions already running | Broker counts in-flight handlers and attaches updates to their preserved success/error results once they finish | Broker and manager integration tests cover concurrent calls and both outcomes |
| Stop stale parallel actions in MCP delivery | Delivered revision gate and explicit `specrails_mission(acknowledge_updates)` | Broker, mission tool, HTTP MCP and manager integration tests cover old acknowledgements, newer input and cross-session consumption |
| Yield a watch promptly | `specrails_watch` listens only to its owning invocation's input notification, cancels its read polling and reports `user_update` | Watch and broker tests verify immediate release, preserved events and no stop/mutation request for the observed job |
| Durable, idempotent input | Desktop migration 27 and `agent-input-store.ts` | Store tests cover migration/reopen, metadata, duplicate/conflicting IDs, limits, rollback and deletion cascade |
| Safe stop and restart | Pending input becomes marked history; unconfirmed native writes cannot replay, even after local receipt persistence failure; capabilities are revoked | Manager tests cover Stop during initial extraction or delivery, new deliberate input after Stop, shutdown and startup recovery |
| Correct transcript chronology | Assistant checkpoint and user message persist atomically; final settlement stores only the remaining segment | Client and manager tests cover stable IDs, duplicate events, HTTP-before-WS, empty final segment and attachments/repository refs |
| Connection recovery | Pending input and active segment snapshots with per-conversation event ordering | Client tests cover active/background missions, reload, reconnect and stale snapshots |
| Preserve rejected drafts | Separate Send/Stop controls, admission result and reusable retry ID | Composer tests cover rejected sends, attachments, references, edits during delivery and retry without duplicate execution |
| Invocation isolation | Unique capability and bearer file for every invocation, including stale-session recovery | Config and manager tests reject old bridge requests and prevent replacement of another invocation's credential file |
| Honest receipt icons | Additive migration28; monotonic receipt updates; native acceptance is distinct from capability-scoped explicit reading; no read inference from synthetic or later output | Store upgrade/reopen, native hooks, manager, broker/tool and client race regressions; desktop/compact visual smoke |
| Explicit pending controls | Busy input defaults to queue; per-message Steer/delete and menu Edit preserve other pending inputs and metadata | Manager/store/router/client regressions cover selective promotion, tombstones, HTTP retries and claims; real components verified visually |

## Validation

- Server affected suite after the final receipt changes: **57 files, 1,201 tests passed**. Agent manager, native provider protocols, MCP, desktop database, shared spawn lifecycle, interactive sessions and CLI wrapper. Covers exact read acknowledgements, initial synthetic output, receipt persistence failure, delivered-ID scoping, HTTP tombstones and migration28.
- Native protocol suites: **18 Claude and 26 Codex tests passed**, using simulated child processes. Codex initialize/start/resume/steer frames also validate against the installed CLI's generated schema.
- Full client regression after queue controls: **367 files, 4,606 tests passed**. After the receipt UI/reconciliation additions, all five affected suites passed again: **175 tests**, including component, context, API and locale parity.
- Root, CLI, MCP bridge and client TypeScript: passed (`npm run typecheck`).
- Production server/client/CLI build: passed (`npm run build`). Existing large-chunk and terminal-font dependency warnings remain non-blocking.
- OpenSpec strict validation and `git diff --check`: passed.
- Chromium visual smoke with actual conversation/composer/queued-message components, fixture state and mocked APIs: two queued messages; menu Edit focuses composer and preserves its earlier draft after saving; Steer promotes only the selected input; delete removes the other; Send queues while Stop remains visible. Desktop 1440×960 and compact 800×760, DPR2, Spanish, Codex and Gemini fixtures; no page errors or horizontal overflow. Temporary harness and Vite server removed/stopped.

- Receipt visual smoke: actual message/queued-message/receipt components at 1440×1080 and 800×1024, DPR2, Spanish. Single gray, double gray and double green checks; exact localized title/accessible labels, no visible status prose, separate warning/cancel icons; no page errors or horizontal overflow. Fixtures removed and temporary server stopped.

## Limits of the evidence

Providers are simulated in automated tests; no paid Claude, Codex, Gemini or Kimi invocation was launched. The tests prove delivery and orchestration, not that a model will always implement a correction correctly. Claude/Codex use their native input channels, with provider-controlled safe boundaries rather than arbitrary token interruption. Gemini/Kimi retain Specrails MCP checkpoints and continuation; experimental alternative transports are not implemented. The browser smoke uses fixture data, not a live user project or database.

Logs: `/tmp/specrails-receipts-server-final.log`, `/tmp/specrails-native-client-verified.log`, `/tmp/specrails-input-receipts-client-tests.log`, `/tmp/specrails-receipts-typecheck-final.log`, `/tmp/specrails-receipts-build-final.log`. Receipt visual report: `/tmp/specrails-input-receipts-smoke-report.json`; screenshots `/tmp/specrails-input-receipts-{1440,800}.png`. Visual report: `/tmp/specrails-queue-controls-smoke-report.json`. Screenshots: `/tmp/specrails-queue-{1440|800}-{pending|menu|editing|steered}.png`.

Receipt evidence: provider acceptance does not establish model reading. Claude replay may precede context folding and Codex steer ACK precedes the next sampling boundary. Consequently both use explicit model acknowledgement for green checks; missing acknowledgement leaves a conservative gray receipt. This also avoids treating synthetic provider notices as proof that the initial prompt was read.
