# Intent: Contain delivery warning toasts so they fit the window and always close

## Problem

After merge-local integration, the cleanup_incomplete toast (and the similar safety-archive toast) renders in a narrow one-word-per-line column, taller than the window, with its close button off-screen. It is persistent (duration Infinity), so the user cannot dismiss it without zooming out, resizing or restarting Desktop.

## Outcome

Delivery warning toasts stay within the window, wrap long paths, scroll internally when long, and always expose a reachable close control, while the full details remain inside the toast and copyable.

## Hypothesis

We believe bounding width and height, wrapping long strings and keeping the close control visible will remove the blocking UX; we will know when a toast with long warnings fits a 700px-high window and closes in one click.

## How we will know

- With 3+ multi-line warnings containing 150-character paths, the toast fits in a 700px-high window
- The toast closes with a single click on a visible control
- Full cleanup details remain readable (scrollable) and copyable via the existing Copy details action
- A client test renders the toast with long cleanupWarnings and asserts the close button is present

## Who and what it affects

- cleanupIncomplete and safetyArchive toasts in RailPrDecisionContext.tsx
- Toaster config and .specrails-toaster styling (App.tsx, globals.css)
- Toast rendering in all 8 locales

## Constraints

- Details stay inside the toast; they are not moved to a dialog or the delivery card
- Cleanup details must not be truncated or lost
- Must work in both top-right and bottom-right toaster positions
- Must hold for long text in all 8 locales

## Open questions

- Is the narrow width caused by .specrails-toaster CSS or sonner's default width in top-right mode? To be verified during implementation.
- Should persistence (duration Infinity) change? Not answered; default is to keep it persistent.
