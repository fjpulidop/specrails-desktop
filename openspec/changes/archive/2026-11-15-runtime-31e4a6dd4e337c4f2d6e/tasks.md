# Tasks

## 1. TitleBar prop and conditional rendering

- [x] 1.1 In `client/src/components/TitleBar.tsx`, add `TitleBar({ showSidebarToggles = true }: { showSidebarToggles?: boolean })` and pass it to `MacTitleBar` and `DefaultTitleBar` only (not `BrowserTitleBar`). Verify with `cd client && npx tsc --noEmit`.
- [x] 1.2 In `MacTitleBar`, render the left `SidebarWindowButton` only when `showSidebarToggles`, keeping the `ml-[80px]` wrapper and `PlaceNavButtons`; render the right one only when `showRight && showSidebarToggles`. Verify via the tests in 3.
- [x] 1.3 In `DefaultTitleBar`, apply the same conditions, keeping the left cluster, `minWidth: 116`, `justifyContent: 'flex-end'`, `InboxButton` and the window controls. Verify via the tests in 3.

## 2. Wire the mission window

- [x] 2.1 In `client/src/App.tsx` `AppRoutes`, change the `<TitleBar />` inside the main/mission tree to `<TitleBar showSidebarToggles={!secondary} />`; leave the loop/plugin `<TitleBar />` as is. Verify with `cd client && npx tsc --noEmit` and `npm run audit:architecture` (no boundary change).

## 3. Tests in `client/src/components/__tests__/TitleBar.test.tsx`

- [x] 3.1 Extend the test wrapper to accept `showSidebarToggles`. Add a macOS mission case: neither sidebar button is present, search pill, back/forward buttons and inbox button are present, and the left cluster still has the `ml-[80px]` class. Verify with `npm run test --prefix client -- src/components/__tests__/TitleBar.test.tsx`.
- [x] 3.2 Add a Windows/Linux mission case: no sidebar buttons, minimize/maximize/close present and clickable, right cluster keeps `justify-content: flex-end` and `min-width: 116px`. Same command.
- [x] 3.3 Add default-prop cases (macOS and Windows/Linux, no prop): both buttons present with unchanged labels/titles, including a `⌘B` / `⌥⌘B` title assertion; keep the existing browser recovery test and the existing loop/plugin-equivalent default render passing. Same command.
- [x] 3.4 Run the whole client suite and root typecheck: `npm run test --prefix client` and `npm run typecheck`; fix any regressions caused by the change.
