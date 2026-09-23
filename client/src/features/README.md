# Frontend capability ownership

Application boot/composition stays in `App.tsx` and `main.tsx`. Each feature owns
its components, state, hooks, API clients, feature utilities and adjacent tests.
Generic UI primitives and shared infrastructure (origin/auth, WebSocket transport,
project caching, routing and native shell helpers) stay outside feature folders.

The [boundary manifest](boundaries.json) records each feature's public subpaths
and direct feature dependencies. Public subpaths avoid an eager barrel importing
React views when a consumer only needs a model or API client. New cross-feature
imports require an explicit manifest update; tests reject undeclared changes and
imports from feature code back into application composition.

The feature READMEs link every externally consumed entry point and collaborating
feature. This is ownership and dependency visibility, not a claim that all existing
UI collaborations are acyclic. Domain/validation code should depend on contracts;
HTTP, storage and native-shell effects belong in hooks or adapters.

Generate reviewed changes with `node scripts/audit-client-features.mjs --write`;
validate with `--check`. Run client coverage after changes spanning capabilities.
