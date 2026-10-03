## Verification

All six implementation tasks and all three requirements are complete. The nine scenarios have adapter/domain/lifecycle and client coverage. No implementation or architecture discrepancies were found.

- Server subscription-usage: 40 tests passed, including the supplied monthly spending example, plan detection, same-session profile fallback, traditional-plan exclusion, missing/zero/unlimited caps, currency units, provider/calendar resets and account isolation.
- Client subscription-usage: 22 tests passed, covering footer/menu/settings money rendering, updated caps, zero and missing data, unlimited budgets, over-limit clipping, passed reset staleness and snapshot contract validation.
- Architecture and desktop route suites: 200 tests passed. Locale suite: 20 tests passed.
- Full TypeScript checks, architecture audit and production build passed. Source map includes the shared financial component; diff whitespace check passed.
- Installed-package checks passed: production consumer install, CLI, MCP bridge, shell resources and tarball integrity.
- A Spanish browser fixture using the production footer and store showed “20,78 US$ de 1000,00 US$ consumidos”, the 2% progress bar, the November 1 reset at 01:00 local time, and unchanged Codex weekly usage. The fixture mocked requests; no live credentials or provider API calls were used.

Remaining validation limit: an authenticated Enterprise account is not available on this workstation. The deployed account response still needs a live smoke check; no live compatibility claim is made from synthetic fixtures.
