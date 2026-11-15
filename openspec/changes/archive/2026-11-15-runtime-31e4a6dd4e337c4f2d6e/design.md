# Design

## Context

`client/src/components/TitleBar.tsx` has three variants: `BrowserTitleBar`, `MacTitleBar` and `DefaultTitleBar` (Windows/Linux). Mac and Default both render `SidebarWindowButton` left (in the left cluster with `PlaceNavButtons`) and right (next to `InboxButton`, when a right sidebar is mounted). `AppRoutes` in `client/src/App.tsx` already computes `secondary = isMissionWindowRoute()` and mounts `<TitleBar />` once (around line 968) for the main and mission windows; loop/plugin windows mount their own `<TitleBar />` (around line 924). See proposal.md for motivation.

## Goals / Non-Goals

**Goals:** remove both sidebar toggles from the mission window title bar only, with no layout shift.

**Non-Goals:** loop/plugin windows, other controls, shortcuts, `SidebarPinContext` behaviour.

## Decisions

- **Prop, not import.** `TitleBar` takes `showSidebarToggles?: boolean` (default `true`); `App.tsx` passes `!secondary`. This avoids `components/` importing from `features/missions` (boundary risk) and keeps `TitleBar` testable without mocking the window location. Rejected: calling `isMissionWindowRoute()` inside `TitleBar`.
- **Window identity, not `uiMode`.** Loop/plugin windows also use agent mode and must not change. Rejected: `uiMode === 'agent'`.
- **One component with a conditional.** Rejected: a separate `MissionTitleBar` (duplicates drag region, search and window controls).
- **Remove, don't disable**, since a disabled toggle still suggests a sidebar exists.
- **`BrowserTitleBar` untouched**; it never receives the prop.

## Layout details

- Mac: the left cluster `ml-[80px] flex items-center gap-2` stays; only the left `SidebarWindowButton` is conditional, so `PlaceNavButtons` still starts at the 80px inset. The right toggle renders when `showRight && showSidebarToggles`.
- Default: the left cluster and the right cluster (`minWidth: 116`, `justifyContent: 'flex-end'`) stay; only the toggle children are conditional.
- `SidebarWindowButton` is the only consumer of `useSidebarPin` in these variants, and it is not mounted when hidden, so pin state is not read for the mission title bar. Existing hook calls in the variants stay unconditional.

## Risks / Trade-offs

- Existing callers are unaffected because the prop defaults to `true`.
- Left-cluster alignment and right-cluster style are asserted in unit tests; a manual check of a detached mission window is still advisable.
