# Subscription usage

Machine-scoped, ephemeral read-only observations for the active host Claude/Codex subscription. No project DB, cost accounting or queue policy dependency. `domain.ts` normalizes missing values and provider windows; `application.ts` owns freshness/backoff policy. Fixed architecture rules protect these cores.

## Public subpaths

- `index.ts`: type-only contracts.
- `runtime/composition.ts`: explicit production composition; no import-time probes.
- `runtime/usage-service.ts`: injected service, single-flight cache, shutdown and type.
- `adapters/http.ts`: desktop route registration.

`GET /api/subscription-usage` reads cached state. `POST /api/subscription-usage/refresh` accepts optional `providerId` and `automatic`; automatic requests skip known nonretryable failures, while manual requests can rediscover installation/auth. Responses contain exactly Claude/Codex rows and explicit `installed` null/true/false. With neither CLI installed, no credential or provider query runs. The existing desktop middleware owns authentication.

Credentials remain inside bounded adapters. Claude checks the active macOS Keychain scope and same-context credential file; other platforms use file-backed OAuth. Codex starts an owned app-server probe with account/read (refreshToken false) and account/rateLimits/read only, then closes it. No PTY fallback, prompt, login or credentials write. Probe stderr and provider error bodies are never returned or logged. Before/after auth fingerprints and response identity invalidate previous accounts. Tokens/fingerprints/identities are not in HTTP snapshots.

Compatibility evidence: Codex generated protocol from the installed CLI and [official app-server documentation](https://learn.chatgpt.com/docs/app-server); synthetic transport fixtures cover unknown methods and multibucket responses. macOS Keychain/config lookup and Claude OAuth shape match the referenced Orca approach; Windows/Linux credential paths are fixture-covered but still need platform smoke validation. macOS may enforce its own Keychain access policy; denied reads become a descriptive state. No subscription visibility is inferred from detection auth heuristics alone.

Refresh floor is 30s; errors back off up to 5m (429 honors Retry-After); successful figures expire after 5m or a passed known reset. No permanent background server timer or persistence. Service disposal aborts and awaits owned probes. UI visibility drives collection.

Validate with `npx vitest run server/modules/subscription-usage`, affected desktop route tests, typecheck and architecture audit. Never use live credentials in fixtures or print raw responses during a smoke check.
