# Proposal

## Why

The native mission window inherits the main window's title bar, including the left and right sidebar toggle buttons. The mission window has no sidebars, so the buttons next to the macOS traffic lights are inert noise that confuses users.

## What Changes

- `TitleBar` gains an optional `showSidebarToggles` prop (default `true`). When `false`, the macOS and Windows/Linux title bars do not render the left or right sidebar toggle button.
- `AppRoutes` in `client/src/App.tsx` passes `showSidebarToggles={!secondary}` (`secondary` is `isMissionWindowRoute()`) to the `TitleBar` mounted for the main and mission windows. The loop/plugin window `TitleBar` and the browser title bar are untouched.
- Layout is preserved: the macOS left cluster keeps its `ml-[80px]` traffic-light inset; the Windows/Linux right cluster keeps `justify-content: flex-end` and `minWidth: 116`.
- Unit tests cover the mission, main, loop/plugin and browser cases.

No persisted data, routes, events or i18n strings change.

## Capabilities

### New Capabilities
- `mission-window-titlebar`: which controls the native mission window title bar shows (no sidebar toggles) and which other title bars stay unchanged.

### Modified Capabilities
- None.

## Impact

- `client/src/components/TitleBar.tsx`, `client/src/App.tsx`, `client/src/components/__tests__/TitleBar.test.tsx`.
- No server, API, dependency or module-boundary changes: the flag is passed as a prop, so `components/` does not import from `features/missions`.
