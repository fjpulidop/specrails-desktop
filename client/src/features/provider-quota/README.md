# provider-quota

Provider usage limits as a first-class signal in the UI: the client copy of the
machine's quota (kept live by `provider_quota.updated`, no polling), the
escalation announcements (≥80 %, ≥90 %, refused → attention category
`budget`), the launch preflight chips of "Launch all", the paused-at-limit card
of loop runs and the usage-limit card of missions.

Server side: [`server/modules/provider-quota`](../../../../server/modules/provider-quota/README.md)
and [`server/modules/launch-preflight`](../../../../server/modules/launch-preflight/README.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Quota view parsing, warning thresholds, shared-quota rule | [lib/types.ts](lib/types.ts) |
| Live store (one read, then server pushes) | [lib/quota-store.ts](lib/quota-store.ts), [ProviderQuotaBridge](components/ProviderQuotaBridge.tsx) |
| Which changes are announced | [lib/quota-attention.ts](lib/quota-attention.ts) |
| Reset times and countdowns (re-render only when the label changes) | [lib/format-reset.ts](lib/format-reset.ts), [lib/useCountdownNow.ts](lib/useCountdownNow.ts) |
| Launch preflight | [lib/launch-preflight.ts](lib/launch-preflight.ts), [LaunchPreflightChips](components/LaunchPreflightChips.tsx) |
| Loop run paused at a limit | [lib/limit-pause.ts](lib/limit-pause.ts), [LimitPauseCard](components/LimitPauseCard.tsx), [RunLimitPause](components/RunLimitPause.tsx) |
| Continue a Core run on another provider (provider/model/effort from `switchTargets`, catalogs from `loops/lib/loop-run-models` and `providers/lib/provider-capabilities`; hidden when the server offers none) | [LimitPauseCard](components/LimitPauseCard.tsx) `SwitchProvider` |
| Mission stopped at a limit | [lib/usage-limit-row.ts](lib/usage-limit-row.ts), [MissionUsageLimitCard](components/MissionUsageLimitCard.tsx) |

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/LaunchPreflightChips.tsx](components/LaunchPreflightChips.tsx)
- [components/MissionUsageLimitCard.tsx](components/MissionUsageLimitCard.tsx)
- [components/ProviderQuotaBridge.tsx](components/ProviderQuotaBridge.tsx)
- [components/RunLimitPause.tsx](components/RunLimitPause.tsx)
- [lib/format-reset.ts](lib/format-reset.ts)
- [lib/labels.ts](lib/labels.ts)
- [lib/limit-pause.ts](lib/limit-pause.ts)
- [lib/types.ts](lib/types.ts)
- [lib/usage-limit-row.ts](lib/usage-limit-row.ts)
- [lib/useLaunchPreflight.ts](lib/useLaunchPreflight.ts)
- [lib/useProviderQuota.ts](lib/useProviderQuota.ts)

## Feature dependencies

- [loops](../loops/README.md)
- [providers](../providers/README.md)
- [subscription-usage](../subscription-usage/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/provider-quota`.
