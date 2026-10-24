# docs

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/DocsDialog.tsx](components/DocsDialog.tsx)
- [pages/DocsPage.tsx](pages/DocsPage.tsx)

## Feature dependencies

No direct feature dependencies.

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/docs`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

`components/DocView.tsx` is the shared document renderer used by both the page
and the dialog (markdown, internal-link routing, loading/error/Retry states).
`/api/docs` is a Desktop-level route, so fetches go through `docsUrl()`
(`API_ORIGIN` prefix), never the project-scoped `getApiBase()`.

Headings can declare an explicit anchor, `## Title {#anchor}` (identical in every locale). `DocView`
renders it as the id `doc-<anchor>` and hides the suffix; the server strips it from page titles.
`DocsDialog` takes a `target` (`lib/docs-events.ts` `DocsTarget` plus a `nonce`), selects that page and
scrolls to the anchor, or to a heading by its text for search results. The target is not part of the
place (`?overlay=docs` is): `App.tsx` drops it on close. See "Contextual help" in
[`features/README.md`](../README.md#contextual-help-learn-more).
