# Proposal

## Why

After a merge-local integration, the persistent `cleanup_incomplete` toast (and the equivalent safety-archive toast) carries long worktree paths and raw git errors. It renders taller than the window with its close button clipped or off-screen, and because `duration: Infinity` it never leaves, so the user cannot dismiss it without zooming out, resizing or restarting Desktop. This blocks the recovery path exactly when the details matter.

## What Changes

- Contain every long-description toast inside the viewport: bounded width (356px preferred, never wider than the viewport), wrapped long tokens, preserved line breaks.
- Make the description the only scrolling region, with a viewport-derived max-height, so title, action button and close control stay visible.
- Keep the close control reachable and unclipped in both toaster positions (top-right and bottom-right).
- Add a client regression test that renders the real Sonner toaster with long warnings and asserts the close button, Copy details action and containment classes.
- No change to toast copy, persistence (`duration: Infinity`), i18n keys, API or data shapes; Copy details still copies the raw joined string.

## Capabilities

### New Capabilities
- `delivery-warning-toasts`: viewport containment, wrapping, internal scrolling and an always-reachable close control for persistent delivery warning toasts (cleanup incomplete, safety archive).

### Modified Capabilities

(none)

## Impact

- `client/src/App.tsx`: shared `toastOptions.classNames` for the Toaster (and a close-button/overflow fix once the clipping cause is confirmed).
- `client/src/features/delivery/context/__tests__/RailPrDecisionContext.test.tsx`: new regression coverage.
- `client/src/globals.css` only if a rule cannot be expressed as classNames (the `[data-sonner-toast]` rules already live there).
- No server, API, dependency or locale-file changes.
