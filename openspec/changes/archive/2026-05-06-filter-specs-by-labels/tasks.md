## 1. Scaffold filter strip component

- [x] 1.1 Create `client/src/features/specs/components/SpecLabelFilterStrip.tsx` exporting a default-named function component with props `{ tickets: LocalTicket[]; doneTickets: LocalTicket[]; active: Set<string>; onToggle: (label: string) => void; onClear: () => void }`
- [x] 1.2 Add `TONES` const tuple and `TONE_CLASSES` static map covering the six accent tokens (`accent-primary`, `accent-info`, `accent-success`, `accent-secondary`, `accent-warning`, `accent-highlight`) with `idle`, `hover`, and `active` class strings, all written as full literal Tailwind classes so the JIT picks them up
- [x] 1.3 Implement `hashLabelToTone(label: string)` using FNV-1a 32-bit on the lowercased label, modulo 6, returning a member of `TONES`
- [x] 1.4 Aggregate label counts from `tickets` only (NOT `doneTickets`) in a `useMemo`, return entries sorted by count desc with alphabetical asc tie-break
- [x] 1.5 Return `null` when the aggregated entry list is empty
- [x] 1.6 Render a horizontal flex container with `overflow-x-auto scrollbar-hide`, edge-fade via `[mask-image:linear-gradient(90deg,transparent,black_12px,black_calc(100%-12px),transparent)]`, `flex-1 min-w-0`
- [x] 1.7 Render the optional leading clear chip `× {active.size} · clear` (only when `active.size > 0`) bound to `onClear`
- [x] 1.8 Render each pill as `<button type="button" aria-pressed={active.has(label)}>` with text `${label} ·${count}`, applying `idle + hover` classes when inactive and `active` classes when active, count rendered with `text-{tone}/60` weight
- [x] 1.9 Add `onWheel` handler that translates vertical wheel into horizontal scroll: only `preventDefault` when `Math.abs(deltaY) > Math.abs(deltaX)` AND the strip is not at the edge in the relevant horizontal direction

## 2. Wire strip into SpecsBoard

- [x] 2.1 In `client/src/features/specs/components/SpecsBoard.tsx` add `const [activeLabels, setActiveLabels] = useState<Set<string>>(new Set())` near the other state hooks
- [x] 2.2 Reset `activeLabels` when `activeProjectId` changes (read from `useHub`); add a dedicated `useEffect`
- [x] 2.3 Add `toggleLabel(label)` and `clearLabels()` handlers using functional `setActiveLabels` updates
- [x] 2.4 Compute `filteredTickets` and `filteredDoneTickets` via `useMemo`: when `activeLabels.size === 0` return the input arrays, else filter to tickets whose `labels` intersects `activeLabels`
- [x] 2.5 Replace the existing `tickets` and `doneTickets` references inside the render path with `filteredTickets` / `filteredDoneTickets` (counts in the SortableContext, the empty-state branches, and rendered children all use the filtered arrays)
- [x] 2.6 Update the count chip in the header: when `activeLabels.size > 0` render `{filteredTickets.length}/{tickets.length}` instead of `{tickets.length}`
- [x] 2.7 Insert `<SpecLabelFilterStrip ... />` between the count chip and the `+ Add` button inside the header flex row, with appropriate `flex-1 min-w-0` so the Add button stays right-pinned
- [ ] 2.8 Verify visually in dev (`npm run dev`) that with mocked tickets carrying labels the strip renders, sorts, scrolls, filters, and clears as designed

## 3. Tests for the filter strip

- [x] 3.1 Create `client/src/features/specs/components/__tests__/SpecLabelFilterStrip.test.tsx`
- [x] 3.2 Test: returns null when no tickets carry labels (asserts no element rendered)
- [x] 3.3 Test: aggregates counts from active tickets only and ignores Done labels
- [x] 3.4 Test: orders pills by count desc with alpha tie-break
- [x] 3.5 Test: pill text format is `label ·N`
- [x] 3.6 Test: hash determinism — same label produces same tone class across remounts
- [x] 3.7 Test: `aria-pressed` reflects `active` set membership
- [x] 3.8 Test: clicking an inactive pill calls `onToggle(label)` once with the label
- [x] 3.9 Test: clear chip renders only when `active.size > 0` and clicking calls `onClear`

## 4. Tests for SpecsBoard filtering

- [x] 4.1 Extend or add a test (`client/src/components/__tests__/SpecsBoardLabelFilter.test.tsx` or extend an existing SpecsBoard test) covering: filter narrows the active list AND the Done section, multi-select OR semantics across two labels, empty active set restores full list, clear chip resets state, count chip flips between `[N]` and `[filtered/total]`
- [x] 4.2 Test: project switch resets filter (re-render with a new `activeProjectId` ⇒ active set is empty)
- [x] 4.3 Test: no `dracula-` substring in the rendered HTML and no `style` attribute carrying a hex color on any pill (regression guard)

## 5. Desktop updater toast wrapper fix

- [x] 5.1 In `client/src/hooks/useDesktopUpdateNotifier.tsx`, add `unstyled: true` to the options object passed to `toast.custom(...)`
- [x] 5.2 Add a regression test in `client/src/hooks/__tests__/useDesktopUpdateNotifier.test.tsx` (create if it does not exist) that mocks `sonner.toast.custom`, drives a mock update via `VITE_MOCK_DESKTOP_UPDATE`, and asserts the call's options object includes `unstyled: true`, `id: 'specrails-hub-desktop-update'`, `duration: Infinity`, and `dismissible: false`
- [ ] 5.3 Manual visual check on macOS Tauri build: confirm no outer ghost outline around the toast in `dracula`, `aurora-light`, and `obsidian-dark` themes

## 6. Theme-token regression and coverage

- [x] 6.1 Run `cd client && npx tsc --noEmit` and fix any type errors introduced
- [x] 6.2 Run `npm test` and fix any failures
- [x] 6.3 Run `cd client && npm run test:coverage`; if client thresholds fall below 80% lines/statements or 70% functions, add tests until thresholds pass — never lower thresholds
- [x] 6.4 Run a repo-wide grep for new `dracula-` token usages (`grep -rn "dracula-" client/src/features/specs/components/SpecLabelFilterStrip.tsx client/src/features/specs/components/SpecsBoard.tsx client/src/hooks/useDesktopUpdateNotifier.tsx`) and confirm zero matches
- [x] 6.5 Run `npm run typecheck` at the repo root and `npm test` once more to confirm a clean state before declaring done

## 7. Verification against specs

- [ ] 7.1 Walk every scenario in `specs/specs-board-label-filter/spec.md` against the running dev server and tick off mentally; if any scenario fails, fix and re-run tests
- [ ] 7.2 Walk every scenario in `specs/desktop-update-notifier/spec.md` against the mock-updater dev session (`VITE_MOCK_DESKTOP_UPDATE=true`) and the macOS Tauri build
- [x] 7.3 Run `openspec validate filter-specs-by-labels` and resolve any reported issues
