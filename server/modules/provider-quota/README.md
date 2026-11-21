# provider-quota

The provider account's usage-limit state ("quota") as a first-class signal:
one machine-wide store of the latest quota per provider, the reporting door
every producer uses, the wake-aware clock that resumes work at a reset, and
the read-only HTTP view. The client feature is
[provider-quota](../../../client/src/features/provider-quota/README.md).

## Sources (freshest wins per window)

| Source | Where it is observed |
| --- | --- |
| Core session `provider.rate-limit` (contract 5.14) | `SessionHostRegistry` `onRateLimit` (composition in `server/index.ts`) |
| Core runtime `agent-event` kind `rate-limit` (jobs, rails, loops) | `agent-runtime-bridge.ts`, live job/loop stream handlers through [stream-observer](runtime/stream-observer.ts) |
| Claude `rate_limit_event` of turns Desktop spawns itself | live line handlers (chat, missions, jobs, interactive steps) through [stream-observer](runtime/stream-observer.ts); never replays of stored logs |
| Provider prose ("You've hit your session limit · resets 3am (Europe/Madrid)") | `server/provider-limit.ts` classifier, kept as the fallback for providers/versions without the typed event; [resolveResetText](domain.ts) turns the words into an instant when they pin one down |
| Subscription usage (OAuth / app-server) | read lazily from the usage service; run reports also update its rows (no extra polling) |

## Rules

- A rejected window is a refusal until its reset; it expires on its own. A
  later allowed report on the same window clears it. Overage that is allowed or
  in use still serves requests, so it is not a refusal.
- Requests resume when EVERY refusing window has reset (`rejectedUntil` is the
  last reset).
- Levels: `warning` at ≥80 %, `critical` at ≥90 %, `rejected`.
- A replayed, older report never moves the state backwards.
- Engines share a quota only within one provider id (`sharesQuota`).
- Work handed to another provider after a refusal carries the prior record as
  historical data the new agent must not obey ([historicalContext](domain.ts)).

## Persistence

Only refusals (window → reset) are persisted, as one `desktop_settings` value
(`provider_quota_refusals_v1`) written when that set changes: a restart must
not forget that the account refuses requests (launching more rails into it),
while utilization is re-read by the subscription reader and the next run. A
loop run paused at a limit persists its own `resumeAt` with the run (see the
loops module).

## Resuming at a reset

[resume-clock.ts](runtime/resume-clock.ts) schedules on the wall clock and only
starts work once the process has been continuously awake for 2 minutes: a
heartbeat (only while something is scheduled) detects sleep as a gap, so a due
resume never starts during sleep or a short dark wake (Power Nap, maintenance
wake). The server has no OS power events, so this gap rule is the guard.

## Public subpaths

- `runtime/composition.ts`: production store + clock, bound to the reporting door.
- `runtime/quota-reports.ts`: `reportRateLimit`, `reportProviderRefusal`, `quotaResumeAt`, `quotaView`, `scheduleLimitResume`.
- `runtime/stream-observer.ts`: live stream lines → reports.
- `adapters/http.ts`: `GET /api/provider-quota`.
- `domain.ts`: pure rules (also used by loops, missions and recovery callers).

Run `npx vitest run server/modules/provider-quota`.
