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
validate with `--check`. `--write` rewrites only the block between the
`audit-client-features:begin` / `:end` markers of each feature README (public
subpaths and feature dependencies, [scripts/client-feature-readme.mjs](../../../scripts/client-feature-readme.mjs));
hand-written sections outside it are kept. `--check` also fails when a block is
stale. Run client coverage after changes spanning capabilities.

## Modals

Every modal follows the [modal standard](../../../docs/internals/modal-standard.md):
`DialogContent` from `components/ui/dialog.tsx` with one of five sizes
(`confirm`, `form`, `wide`, `workspace`, `fullscreen`), a sticky `DialogHeader`
(it owns the close button), `DialogBody` as the only scroll region and a sticky
`DialogFooter` with Cancel (ghost) before the primary action. Confirms use
`ConfirmDialog`. Stacking uses the named layers in `lib/layers.ts` (`base` 50,
`entity` 65, `stacked` 70, `capture` 80, `media` 100), never a literal
`z-[NN]`. Only `workspace` modals are resizable. Text inside a modal is at
least 12px (11px only on `data-chip` pills). Anything a user consults while
working (Docs, Analytics, activity log) is a candidate for a side sheet rather
than a modal. `components/ui/__tests__/modal-standard-guard.test.ts` rejects
hand-rolled `aria-modal` dialogs outside `components/ui` and sub-12px text in
modal files.

