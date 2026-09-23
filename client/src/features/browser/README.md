# browser

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/browser-capture/BrowserCaptureModal.tsx](components/browser-capture/BrowserCaptureModal.tsx)
- [components/browser-capture/CapturedDomPanel.tsx](components/browser-capture/CapturedDomPanel.tsx)
- [components/browser-capture/NativeBrowserPane.tsx](components/browser-capture/NativeBrowserPane.tsx)
- [context/WebViewModalContext.tsx](context/WebViewModalContext.tsx)
- [lib/browser-capture.ts](lib/browser-capture.ts)
- [lib/frame-activity.ts](lib/frame-activity.ts)
- [lib/native-browser.ts](lib/native-browser.ts)

## Feature dependencies

No direct feature dependencies.

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/browser`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
