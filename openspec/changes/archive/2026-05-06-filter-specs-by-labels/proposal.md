## Why

The Specs column in the project board can grow into dozens of tickets across many themes (auth, api, ui, perf, etc.) but currently offers no way to slice by label. Users must scroll the full list and parse priority badges to find related work. At the same time, the macOS desktop update toast renders with a stray outer outline because `toast.custom` keeps Sonner's default chrome under our custom card — small but a polish bug visible on every release notification.

## What Changes

- Add an inline label-pill filter row to the SpecsBoard header, between the `Spec [N]` count and the `+ Add` button.
  - Pills are derived from the active (non-Done) tickets' `labels[]`, sorted by frequency desc with alphabetical tie-break, and rendered as theme-token colored pastilles (deterministic hash → 1 of 6 accent tokens) at `h-5 text-[10px]`.
  - Strip is horizontally scrollable with edge fade-mask; vertical wheel translates to horizontal scroll. No chevrons. Native scroll only.
  - Multi-select OR semantics: click toggles the label in the active set; tickets render iff they have ≥1 active label. Empty active set = no filter applied. Filter applies to BOTH the active list and the Done section.
  - When the active set is non-empty, a leading `×N · clear` chip appears at the start of the strip and the count flips from `[N]` to `[filtered/total]`.
  - Filter state is in-memory only (no persistence across reloads), per project.
  - Pill row is hidden entirely when zero active tickets carry any label.
- Fix the desktop updater toast wrapper bug: pass `unstyled: true` to the `toast.custom` call in `useDesktopUpdateNotifier`, removing the duplicated Sonner default chrome that surrounds the custom card on macOS.

## Capabilities

### New Capabilities

- `specs-board-label-filter`: inline label-pill filter row in the Specs column with multi-select OR filter, theme-token coloring, frequency sort, and horizontal scroll with edge fade.
- `desktop-update-notifier`: codifies the desktop update toast UX (already exists in code, never specified) including the `unstyled: true` requirement so future Sonner integrations preserve the custom chrome.

### Modified Capabilities

<!-- none -->

## Impact

- **Code**: `client/src/features/specs/components/SpecsBoard.tsx` (header layout, filter state, filter application to active + Done), one new component (`SpecLabelFilterStrip`) co-located in `client/src/components/`, `client/src/hooks/useDesktopUpdateNotifier.tsx` (one-line `unstyled: true`).
- **Tests**: client unit tests for the filter strip (frequency sort, hash → tone determinism, multi-select toggle, clear chip behavior, hidden when no labels) and a regression test for the updater toast options.
- **APIs**: none. No server changes. `LocalTicket.labels` already exists.
- **Theme tokens**: uses existing `accent-primary | info | success | secondary | warning | highlight` only. No new tokens, no `dracula-*` references.
- **Dependencies**: none added.
- **Coverage**: must keep client thresholds (80% lines/statements, 70% functions). New component and tests sized accordingly.
