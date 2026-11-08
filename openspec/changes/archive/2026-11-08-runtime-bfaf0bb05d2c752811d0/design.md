# Design

## Context

See proposal.md for motivation. Current state, observed in source:

- `client/src/App.tsx` `ThemedToaster` mounts one global Sonner `<Toaster closeButton visibleToasts={6} gap={8}>` (sonner 2.0.7) with `toastOptions.unstyled: true`. The toast class is `glass-card ... flex items-start gap-2 w-[356px] max-w-[356px] overflow-hidden`; description is `text-muted-foreground mt-0.5` with no wrapping or height bound; `actionButton` is `whitespace-nowrap shrink-0`.
- Sonner's own stylesheet positions `[data-close-button]` absolutely (`left: var(--toast-close-button-start)`, `top:0`, 20x20, translated about -35%/-35%), i.e. straddling the toast's top-left corner. `unstyled` only removes sonner's `data-styled` look; this positioning still applies.
- `RailPrDecisionContext.tsx` (~L212-230) emits `toast.warning(title, { description: <lines>.join('\n'), duration: Infinity, action })` for `safetyArchives` and `cleanupWarnings`. Unchanged by this design.
- `globals.css` `[data-sonner-toast][data-styled='true']` rules do not apply under `unstyled`, so classNames in App.tsx are the effective styling surface.

### Open questions investigated

1. *Width cause (CSS vs sonner default):* `w-[356px] max-w-[356px]` is explicit, so sonner's default width is not the cause. The strongest code-level hypothesis: the toast is a flex row (`[icon][content flex-1 min-w-0][action shrink-0 nowrap]`), so a long, unwrappable Copy label (longer in some locales) or a long unbroken token plus `overflow-hidden` squeezes `content` to a sliver. Not reproduced in a browser during planning; task 1 must confirm with a rendered measurement before final width/flex rules are chosen.
2. *Close button off-screen:* hypothesis, from the sonner CSS above: the button straddles the top-left corner, so `overflow-hidden` on the toast clips ~35% of it, and a toast taller than the window pushes its top edge (and so the button) off-screen. Bounding height and pulling the button inside the toast box fixes both. Confirm in task 1.
3. *Persistence:* default is keep `duration: Infinity` (no requester answer). 

## Goals / Non-Goals

**Goals:**
- Toast width = 356px preferred, `min(356px, viewport - margins)` effective.
- Description: `whitespace-pre-wrap`, `[overflow-wrap:anywhere]`, `overflow-y-auto`, viewport-derived max-height; title, action, close outside it.
- Close control fully inside the toast box, so toast-level `overflow-hidden` is compatible with it.
- Regression test with the real Sonner `Toaster`.

## Non-Goals

- No move of details into a dialog or delivery card; no truncation.
- No change to persistence, copy, i18n keys, API, event or data shapes, or to `RailPrDecisionContext.tsx`.
- No per-toast overrides and no redesign of non-long toasts beyond shared containment rules.
- No `globals.css` change and no new dependency.

## Assumptions

- Width cause (CSS vs sonner default in top-right): assumed it is flex squeeze from the nowrap action button / unbreakable content, not sonner's default width; to be confirmed in task 1.
- Persistence (`duration: Infinity`): assumed unchanged.

## Decisions

1. **Fix in shared `toastOptions.classNames`** (App.tsx) so every long-description toast benefits. Rejected: per-call `className` on the two producers (duplicated, misses future toasts); inline styles.
2. **Toast box:** keep `overflow-hidden`; add `max-w-[min(356px,calc(100vw-2rem))]` (replacing the fixed `max-w-[356px]`, keeping `w-[356px]` as the preferred width; use `w-full` semantics if measurement shows `w` must shrink too) and `max-h-[calc(100vh-2rem)]`. Add right padding so content clears the close button.
3. **Close button inside the box:** `closeButton` classes override sonner's offsets with Tailwind important modifiers (repo convention, e.g. `border-[...]!`): `top-1.5! right-1.5! left-auto! transform-none!`. Works identically in top-right and bottom-right because it no longer depends on the corner overhang. Rejected: removing `overflow-hidden` (lets the glass-card/halo effects and long tokens leak and does nothing for off-screen height).
4. **Description scroll:** `max-h-[min(40vh,16rem)] overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] min-w-0`. 40vh/16rem (tighter than the ticket's 60vh/24rem example) because title + hint + action add roughly 100px: at 700px, 280px description + chrome stays well under the window, and two expanded toasts still fit. Content column keeps `min-w-0`.
5. **Action button:** if task 1 confirms squeeze, allow it to wrap (`whitespace-normal`, bounded `max-w-[45%]`) instead of `whitespace-nowrap`; otherwise leave it. The width rule is chosen from rendered evidence.
6. **Test seam:** export the classNames object from App.tsx as a named constant (`SPECRAILS_TOAST_CLASS_NAMES`) so the test renders sonner's real `Toaster` with the production classes. Rejected: asserting on App.tsx source text (brittle); a new component file (unneeded layer).

## Local reference patterns

- Toaster config and class strings: `client/src/App.tsx` `ThemedToaster` (`toastOptions.classNames`, important-modifier style `border-[color:var(--toast-warning-border)]!`).
- Producers: `client/src/features/delivery/context/RailPrDecisionContext.tsx` (`toast.warning` for `safetyArchives` / `cleanupWarnings`).
- Tests: `client/src/features/delivery/context/__tests__/RailPrDecisionContext.test.tsx` — mocks `sonner` with `vi.mock('sonner', () => ({ toast: mockToast }))` and asserts on `mockToast.warning` args (cases "announces retained recovery work…" and "keeps terminal safety archives visible…"). Other tests mock `Toaster: () => null`; `client/src/__tests__/App.test.tsx` mocks it as a div. No existing test renders the real Toaster; none to copy for that part.
- Async/state: toasts are imperative and synchronous in the existing tests; the real-Toaster test must `await` `findBy*`/`waitFor` since Sonner mounts toasts after a state update. Use `vi.importActual('sonner')` inside the new test (the file-level mock stays for existing cases) and clean up with `toast.dismiss()`.
- jsdom does no layout, and Sonner's injected stylesheet is not applied the same way; tests assert DOM presence, `data-close-button`, class tokens and click-to-dismiss, not pixel fit.

## Blast radius

| File | Reason |
| --- | --- |
| `client/src/App.tsx` | Extract/export shared toast classNames; width, max-height, description wrapping/scroll, close-button repositioning, optional action wrap. |
| `client/src/features/delivery/context/__tests__/RailPrDecisionContext.test.tsx` | Real-Toaster regression test for long cleanup and safety-archive warnings. |

Not changed: `RailPrDecisionContext.tsx`, `globals.css`, locale files (no keys or copy change; the 8 locales are covered by the layout being text-length independent), docs, server.

## Risks / Trade-offs

- [Cause unconfirmed] → Task 1 measures in a real browser before finalizing rules; rules are all in one class string, easy to adjust.
- [Important modifiers fighting sonner CSS] → verified by the test asserting class tokens plus browser check; Tailwind v4 `!` suffix is already used in this file.
- [Expanded stack of 6 tall toasts can exceed the viewport on hover] → front toast is bounded to roughly 380px max; sonner collapses the rest by default. Accepted; flagged for manual check at 700px.
- [jsdom cannot prove fit] → manual 700px check, both toaster positions, one long locale (German or similar), documented in the PR.
- [Exporting a constant from App.tsx] → App.tsx already exports; if a react-refresh lint rule complains, keep the constant file-local export only used by the test.

## Out-of-scope findings

None blocking. `globals.css` `data-styled` toast rules are dead under `unstyled: true`; left untouched.
