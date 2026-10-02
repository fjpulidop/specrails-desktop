## 1. Repository controls

- [x] 1.1 Extend the shared selector with optional single-repository visibility and contextual labels without changing authoring defaults.
- [x] 1.2 Load pinned repository context, reconcile live requirements, expose launch controls and trim workspace selections.
- [x] 1.3 Display each saved spec scope and add explicit Save/Cancel editing through existing ticket PATCH.

## 2. Verification and delivery

- [x] 2.1 Cover stale proposals, scope saves/cancel/failure, required/optional targets, unavailable/loading state and project isolation.
- [x] 2.2 Add translated copy for all supported languages and update the mission guide and feature README.
- [x] 2.3 Run affected client tests, typecheck, architecture checks and build; validate/archive the change and update the existing PR.

Validation: 772 client tests passed across 50 files (Missions, repository selector, locale parity and i18n). Root/CLI/bridge/runner/client typechecks, architecture audit and production build passed. Spanish browser fixture confirmed adding/removing saved spec targets updates visible assignments and launch requirements. Real server admission remains authoritative; no live job or user's spec was changed by the browser fixture.
