## Context

The Specs column lives in `client/src/features/specs/components/SpecsBoard.tsx`. Its header today is a single flex row: `[icon] Spec [count]` on the left, `+ Add` button on the right, height `h-12`, with `border-b border-border/40`. Tickets carry `labels: string[]` already (defined in `client/src/types.ts:78,258`) but the field is never rendered or queried in the UI. The board splits its body into an active `tickets` list and a collapsed `doneTickets` section, both rendering `<SpecCard>` instances.

Theme tokens are mandated by `CLAUDE.md`: only semantic tokens (`accent-primary | info | success | secondary | warning | highlight | surface | background-deep`) plus shadcn shadcn-style `background/foreground/card/muted/destructive`. A regression guard greps for `dracula-*`, so brand-named tokens are forbidden. Themes can change at runtime — pill colors must be expressible purely as Tailwind classes referencing those tokens (no hex values, no inline styles for color).

Sonner's `toast.custom(...)` renders the custom node inside Sonner's default `[data-sonner-toast]` element which paints its own background and border. The desktop update toast in `client/src/hooks/useDesktopUpdateNotifier.tsx:190-194` does not pass `unstyled: true`, so on macOS (where Sonner's default chrome is most visible against `bg-surface/95`) a ghost outline is drawn around the custom card.

Stakeholders: hub end-users (the dashboard surface), the small Q4 polish track that previously shipped `JobTicketHeader` and the minimizable chats — same visual idiom (glass card, theme-coherent accents, restrained chrome).

## Goals / Non-Goals

**Goals:**
- Add a label-pill filter that is **non-invasive**: preserves the current Spec/Rails column proportions, fits inside the existing `h-12` header, and does not displace `+ Add`.
- Theme-coherent coloring that updates live with theme switches and survives all three built-in themes.
- Multi-select OR filtering applied uniformly to the active list and the Done section.
- Horizontal-scrolling overflow with edge fade affordance and wheel-to-horizontal translation; zero new dependencies.
- Fix the desktop update toast double-chrome bug as part of the same change so the polish track lands together.

**Non-Goals:**
- No persistence of the filter across reloads (in-memory state only). If the user wants persistence later, that is a follow-up.
- No keyboard navigation through pills (Tab into pill, arrow keys). Pills remain `<button>` elements so default Tab order works, but no roving tabindex / Arrow-key shortcut.
- No editing labels from the pill row. Labels are still authored elsewhere (Explore Spec / ticket modal).
- No server changes. No new REST endpoints.
- No reorganization of the header beyond adding the strip.
- The desktop updater toast UX is **codified, not redesigned** — only the wrapper bug is fixed and the existing behaviour is captured as a spec so it does not regress.

## Decisions

### Color mapping: deterministic hash → 6 theme accent tokens

Pick from `[accent-primary, accent-info, accent-success, accent-secondary, accent-warning, accent-highlight]`. Use a stable hash of the lowercased label (FNV-1a 32-bit, ~10 lines, no dep) modulo 6 to pick the bucket. Same label → same bucket forever, same in every theme — only the resolved color changes when the theme switches. Collisions are visually acceptable at typical N ≤ ~20 labels per project.

Tailwind classes per state (resolved at render time as `${tone}` interpolations into a known-good set, not arbitrary strings, so JIT picks them up — see "Tailwind class safelist" risk):

- inactive: `bg-{tone}/10 text-{tone} border border-{tone}/20`
- hover (inactive): `bg-{tone}/15`
- active: `bg-{tone}/25 text-{tone} border-{tone}/60 ring-1 ring-{tone}/30`

Alternatives considered:
- **Opacity rank** (all `accent-primary`, varying `/100 → /40` by frequency rank). Rejected: harder to distinguish visually once N > 4, no per-label identity (color drifts as counts change).
- **Random per-mount color**: rejected — same label appearing twice in two different boards would mismatch.
- **User-assigned color via UI**: out of scope, far heavier than the requested polish.

### Overflow: native horizontal scroll + edge mask + wheel translation

`overflow-x-auto scrollbar-hide` on the strip. Edge fade via `mask-image: linear-gradient(90deg, transparent, black 12px, black calc(100% - 12px), transparent)` applied via Tailwind arbitrary value `[mask-image:...]`. Mask is rendered unconditionally — when content fits, the masked transparent zones simply have nothing under them, so there is no visual artifact. When content overflows the masked edge tells the user there is more to scroll.

Vertical wheel → horizontal scroll: `onWheel` handler that calls `e.currentTarget.scrollLeft += e.deltaY` and `e.preventDefault()` only when `Math.abs(deltaY) > Math.abs(deltaX)` AND the strip can scroll in that direction (clamps avoid trapping wheel events at the edges). This matches VSCode tab-strip behaviour.

Alternatives considered:
- **Chevron buttons left/right**: rejected — adds two more interactive targets to a header that already carries `+ Add`, making the surface feel busy. User explicitly asked for "no muy invasivo".
- **Snap-to-pill**: rejected — pills have variable widths (label length differs), snap would feel jittery.

### Filter state location and scope

Local `useState<Set<string>>` inside `SpecsBoard`. Not lifted to `HubProvider`. Not persisted to `localStorage`. Reset on project switch — handled implicitly because `SpecsBoard` is rendered under the project route and remounts (or at least is keyed by project) when project changes; if not, an explicit `useEffect(() => setActive(new Set()), [activeProjectId])` is added.

Pills are computed via `useMemo` on `tickets` only (active list, not Done). Filtering is then applied to both `tickets` and `doneTickets` for rendering. Counts on the leading `Spec [N]` adapt: shown as `[filteredCount/totalCount]` whenever `active.size > 0`.

### Pill component

A small co-located component `SpecLabelFilterStrip` in `client/src/features/specs/components/SpecLabelFilterStrip.tsx`, props `{ tickets, doneTickets, active, onToggle, onClear }`. Returns `null` if no labels present. Internally:
- aggregates counts (`Map<string, number>`)
- sorts entries: count desc, label asc on tie
- renders an optional leading clear chip when `active.size > 0`: `× {active.size} · clear`
- renders pills as `<button type="button">` with `aria-pressed={active.has(label)}`

Format: `auth ·8` — count rendered with `text-{tone}/60` so the label dominates. Hidden when count = 1? No, keep — frequency-1 labels are still useful filters; the design simply renders the count regardless.

### Done section filter behaviour

Apply the same filter set. The user reasoned that "auth" should mean "auth specs everywhere" — coherent and predictable. The Done header is unchanged; only the rendered list is filtered. If filter excludes all Done items, the existing empty-state copy ("No completed specs yet") is reused — no special "no matches" copy at this scale.

### Tailwind class safelist

Tailwind JIT only emits classes it can statically detect. Because tone is computed at runtime, we either:
1. Build classes via known-good template literals using one of 6 hard-coded tones, or
2. Maintain a small `safelist` in `client/tailwind.config` (Tailwind v4 supports `@source inline("...")` directives in CSS).

Decision: option 1. Define a const map at the top of `SpecLabelFilterStrip`:

```ts
const TONES = ['accent-primary','accent-info','accent-success','accent-secondary','accent-warning','accent-highlight'] as const
const TONE_CLASSES: Record<typeof TONES[number], { idle: string; hover: string; active: string }> = {
  'accent-primary':   { idle: 'bg-accent-primary/10 text-accent-primary border-accent-primary/20', hover: 'hover:bg-accent-primary/15', active: 'bg-accent-primary/25 border-accent-primary/60 ring-1 ring-accent-primary/30' },
  // ... 5 more
}
```

All 6 strings are statically present so JIT picks them up. No safelist edit needed.

### Desktop updater toast fix

One-line change in `useDesktopUpdateNotifier.tsx`: add `unstyled: true` to the toast.custom options object. Verify visually that the gradient/blur backdrop on the card itself is preserved and the outer ghost outline is gone. Add a regression test asserting that the options object passed to `toast.custom` has `unstyled: true`.

The codified spec for `desktop-update-notifier` documents the existing behaviour (Tauri-only mount, dismissed-version localStorage, progress states, restart action) plus the wrapper-strip requirement, so future contributors do not re-introduce the bug.

## Risks / Trade-offs

- **Hash collisions on label tones** → two different labels can render with the same accent. Mitigation: with 6 buckets and typical N≤20 labels, occasional collision is acceptable; identity is preserved by the label text inside the pill, not color alone. If a project hits >20 labels and color confusion is reported, the bucket count can grow to 8 or 10 by extending `TONE_CLASSES` (additive change).
- **Mask-image browser support** → mask-image is broadly supported on all Chromium-based runtimes (Tauri's WebKit and Edge WebView2). For the (unsupported) edge case it degrades to no fade, scroll still works.
- **Wheel-to-horizontal trap** → if the user is mid-page-scroll and the cursor passes the strip, vertical scroll could be hijacked. Mitigation: only translate when both `Math.abs(deltaY) > Math.abs(deltaX)` AND the strip is actually horizontally scrollable AND not already at the relevant edge. At edges, do not call `preventDefault`, letting the wheel event bubble back to the page.
- **Filter persists into Done section** → if a user filters by "auth" they expect to see only auth Done items. This is intentional, but might surprise users who use Done as a "completed work archive". Acceptable trade-off because the alternative (asymmetric filtering) is more confusing.
- **Sonner `unstyled: true`** → strips Sonner's default ARIA role on the wrapper. Mitigation: the inner card is a `<div>` and Sonner still emits the live region wrapper around the toast container; assistive tech still announces the new toast. If a future Sonner upgrade changes the role contract, the regression test on the option object protects the change but a manual screen-reader pass is wise before next release. Manual check noted in `tasks.md`.
- **Theme-token regression guard** → all six tones are referenced explicitly with `accent-*` tokens; no `dracula-*` strings introduced.
- **Coverage** → the new component is small enough that a single test file covering aggregation, hash determinism, multi-select toggle, clear, and hidden-when-empty keeps client coverage above 80% lines/statements.
