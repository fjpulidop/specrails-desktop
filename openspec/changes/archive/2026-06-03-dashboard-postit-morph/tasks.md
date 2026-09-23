## 1. Schema & shared types

- [x] 1.1 Bump JSON store `CURRENT_SCHEMA_VERSION` to `'1.3'` and add normalisation for `short_summary` field in `server/modules/specs/runtime/ticket-store.ts` (store is JSON, not SQLite — adjusted from original wording)
- [x] 1.2 Extend `Ticket` type with `short_summary: string | null` (server) and `short_summary?: string | null` (client `types.ts`)
- [x] 1.3 Update ticket creation sites (`project-router.ts` ×4, `smash-runner.ts`) to set `short_summary` on insert; REST/WS payloads serialise via existing JSON path (no special handling needed)
- [x] 1.4 Add server-side helper `clampShortSummary(raw)` in `ticket-store.ts` — trims, strips ASCII control chars, hard-caps at 240 chars, returns `null` for empty
- [x] 1.5 Unit tests for normalisation (1.2 → 1.3 back-compat), schema bump, and clamp helper (`server/modules/specs/runtime/ticket-store.unit.test.ts`)

## 2. AI flows — generate short_summary

- [x] 2.1 Quick: extended Markdown template with `## Short Summary` section; output is markdown not JSON so used regex extraction (`extractShortSummary`) — tolerates absence
- [x] 2.2 Quick: parses response via `extractShortSummary` + `clampShortSummary`; persisted on ticket; existing `ticket_created` broadcast already includes the field via standard JSON serialisation
- [x] 2.3 Tests for `extractShortSummary` (present, absent, empty, multi-line)
- [x] 2.4 Explore: `from-draft` accepts explicit `shortSummary` body field; falls back to `## Short Summary` section extraction in description; preserves prior on flip when omitted
- [x] 2.5 Tests: fresh-insert with body field, fresh-insert with description extraction, flip preserves when omitted, null persisted when neither provided
- [x] 2.6 SMASH (Simple): extended JSON schema in `buildSmashSimpleSystemPrompt` to include optional `shortSummary` per child
- [x] 2.7 SMASH (Full): same in `buildSmashFullSystemPrompt`
- [x] 2.8 SMASH: validator accepts optional `shortSummary`, rejects non-string when present; tests added to `explore-smash.test.ts`; runner persists via `clampShortSummary` to handle empty strings
- [x] 2.9 AI Edit (real ticket-refine flow, not `agent-refine-manager.ts` which is for custom agents): extended `POST /tickets/:id/ai-edit` prompt with `SHORT-SUMMARY:` output line; PATCH `/tickets/:id` accepts `short_summary` field (string clamps, null clears, omit preserves)
- [x] 2.10 Test coverage piggybacks on existing PATCH ticket tests (TODO: explicit short_summary test when client wiring lands)

## 3. Dashboard splitter — core mechanics

- [x] 3.1 `DashboardSplitter.tsx` (vertical handle, pointer-drag tracking via window listeners + `requestAnimationFrame` throttling implemented in `useDashboardSplit`)
- [x] 3.2 Wired into `DashboardPage.tsx`; left panel now uses explicit `width: ${leftWidth}px`, right panel grows
- [x] 3.3 Min-width clamping (`MIN_LEFT_PX=320`, `MIN_RIGHT_PX=180`) + viewport clamp on mount / project switch / resize
- [x] 3.4 Persists to `localStorage['specrails-hub:dashboard-split:<projectId>']` on `pointerup`
- [x] 3.5 Restores on mount + re-runs effect on `projectId` change
- [x] 3.6 Double-click on splitter → `resetToDefault` (50/50)
- [x] 3.7 Snap zones at 600 and 900 px with ±30 px tolerance (`snapToBreakpoint` on drag release)
- [x] 3.8 Splitter not rendered when `viewport < DISABLE_BELOW_VIEWPORT_PX (900)`; left panel takes 100%
- [x] 3.9 Tests in `client/src/features/dashboard/hooks/__tests__/useDashboardSplit.test.tsx` (12 cases — mount, persistence, clamp, reset, project switch, resize-disable)

## 4. SpecsBoard tiers

- [x] 4.1 Tier derivation lives in the hook (`tierForWidth`) — `SpecsBoard` consumes `tier` prop, no ResizeObserver needed (simpler architecture, parent owns width)
- [x] 4.2 `SpecsBoard.tsx` branches active-list rendering by tier (postit grid vs. row/card SortableContext)
- [x] 4.3 Row tier renders the existing `SpecCard` in a `space-y-1.5` stack — visually unchanged from before
- [x] 4.4 Card tier uses the same `SpecCard` in a `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))` layout (denser CSS, no new component required)
- [x] 4.5 `TicketPostitCard.tsx` — id, title, priority pill, draft pill, dependency indicator, parent-épica chip, short_summary (when present), Move-to-Rail button
- [ ] 4.6 Framer-Motion `layout` not adopted (not in dependencies; CSS `transition-all` provides smooth feel). Documented deferral.
- [x] 4.7 Tests in `TicketPostitCard.test.tsx` (7 cases) + reused `SpecsBoard.test.tsx` (14 cases, all green)

## 5. Move to Rail popover

- [x] 5.1 New shared helper `handleMoveTicketToRail(ticketId, railId)` in `DashboardPage` — drag path can be refactored to call it as a follow-up; current behaviour preserved
- [x] 5.2 `MoveToRailPopover.tsx` — custom popover (Radix popover not installed); lists rails with status dot, click-outside / Esc to close
- [x] 5.3 Wired into `TicketPostitCard` via anchor-rect positioning
- [x] 5.4 Sonner `toast.success` / `toast.info` (already imported in DashboardPage)
- [x] 5.5 Postit popover test covers list + selection; existing drag-and-drop ticket-to-rail tests pass unchanged

## 6. Rails panel compact layout

- [x] 6.1 `density: 'normal' | 'compact'` prop added to `RailRow`
- [x] 6.2 Compact branch renders premium glass mini-card: drag grip + status dot + truncated name + Profile picker + Mode dropdown + Play/Stop + spec count badge
- [x] 6.3 Glass chrome: `bg-card/80 backdrop-blur` + tonal border (`accent-success/40` running, `accent-info/30` hover, `border-border/40` idle); running state pulses via `animate-pulse` on the status dot
- [x] 6.4 `RailsBoard` measures own container with `ResizeObserver`; switches density when width < `RAILS_COMPACT_THRESHOLD_PX (220)`
- [x] 6.5 `RailProfileSelector` (existing) reused — already compact-friendly; no changes needed
- [x] 6.6 Tests in `RailRow.test.tsx` (4 new cases — compact renders, rename works, drop zone hidden, delete in jiggle mode)

## 7. Theming, accessibility, polish

- [x] 7.1 All new components use semantic tokens (`accent-info`, `accent-success`, `accent-secondary`, `accent-highlight`, `bg-card`, `border-border`, `text-muted-foreground`, `text-foreground`) — no brand-named colors
- [ ] 7.2 Splitter keyboard arrows: focus-ring landed, but arrow-key nudge implementation deferred (the leaf component cannot directly set `leftWidth` without lifting the API; deferred to follow-up)
- [x] 7.3 Splitter has `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `tabIndex=0`
- [x] 7.4 Snap-zone markers render as 1 px translucent columns when within ±30 px of a breakpoint
- [ ] 7.5 Manual perf QA with 200+ tickets — pending hands-on session in the running app

## 8. Coverage & verification

- [x] 8.1 `npm run typecheck` (server + client) clean
- [x] 8.2 Full suite passes: 2087 server + 2065 client tests, zero failures
- [x] 8.3 `npm run test:coverage` (server) — **81.36% lines / 70.97% branches / 86.46% functions / 82.81% statements** → meets `80/70/80/80` gate
- [x] 8.4 `cd client && npm run test:coverage` — **81.89% lines / 80.84% branches / 72.20% functions / 81.89% statements** → meets `80/_/70/80` gate
- [ ] 8.5 Manual browser QA — pending hands-on session (run `npm run dev`, drag splitter through tiers, exercise Move-to-Rail on a postit, verify rails compact at ≤220 px)
- [x] 8.6 No regressions: drag-and-drop ticket-to-rail tests, horizontal Spec/Done slider tests, SpecsBoard / RailRow / DashboardPage suites all green
