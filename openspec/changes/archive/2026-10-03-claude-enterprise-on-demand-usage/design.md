## Context

The machine-scoped subscription-usage feature queries Claude's OAuth usage endpoint using the active local credentials. Its domain and UI currently represent only percentage windows. Enterprise consumption responses can instead carry `extra_usage` money fields.

## Goals / Non-Goals

**Goals:** Automatically show assigned Enterprise monthly spend budgets, preserve conventional plan windows, retain account isolation and read-only credential handling.

**Non-Goals:** Admin API integration, manual caps, local cost estimates, organization-wide reports, changing Core or provider execution policy.

## Decisions

- Read `claudeAiOauth.subscriptionType`; use a bounded OAuth profile lookup only when spend data needs classification and local subscription metadata is absent. An unknown plan never becomes Enterprise by assumption.
- Select the spend view only for confirmed Enterprise with monetary data and no meaningful conventional usage windows. Traditional Enterprise, Pro, Max and Team retain their current windows even when extra usage is present.
- Add a separate optional Enterprise spend object to the adapter contract and a nullable field to machine snapshots. Preserve measured zero, unknown amount, unlimited versus missing cap, ISO currency and percentages above 100; clamp only the rendered bar.
- Convert OAuth monetary minor units to display amounts using the currency exponent. Prefer a supplied reset; otherwise use the documented first calendar day at 00:00 UTC. A passed reset marks observations stale without setting measured spend to zero.
- Reuse the existing collection floor, cancellation, account fingerprint, stale retention and sign-out clearing. Share monetary rendering between menu and settings.

## Risks / Trade-offs

- Internal OAuth response changes → bounded parsing, field validation and synthetic fixtures; malformed financial data never becomes a zero-dollar observation.
- Missing plan metadata → profile lookup with the same session; failure remains explicit and cannot produce fabricated Enterprise detection.
- Financial nulls and disabled budgets → retain unknown/unlimited distinctions and show a percentage bar only when it can be measured or derived.
- No live Enterprise session on this workstation → fixture and browser validation cover the supplied example; the user's provider response remains a live smoke check.
