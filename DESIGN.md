---
name: Specrails Desktop
description: A quiet, dense dispatch desk for specs travelling down rails to delivery.
colors:
  night-ink: "hsl(240 33% 4%)"
  night-ink-deep: "hsl(240 40% 2%)"
  panel: "hsl(240 30% 8%)"
  surface: "hsl(238 28% 11%)"
  chrome: "hsl(238 22% 16%)"
  hairline: "hsl(240 25% 100% / 0.14)"
  ink: "hsl(240 20% 95%)"
  ink-muted: "hsl(240 13% 62%)"
  signal-cyan: "hsl(187 100% 44%)"
  lamp-running: "hsl(234 92% 76%)"
  lamp-done: "hsl(152 78% 48%)"
  lamp-caution: "hsl(42 92% 58%)"
  lamp-failed: "hsl(12 80% 55%)"
  lamp-review: "hsl(322 55% 72%)"
  lamp-flow: "hsl(170 78% 50%)"
  rail-violet: "hsl(280 45% 62%)"
  paper: "hsl(220 25% 99%)"
  paper-ink: "hsl(230 28% 14%)"
typography:
  display-xl:
    fontFamily: "system-ui (SF Pro / Segoe UI Variable)"
    fontSize: "2.5rem"
    fontWeight: 600
    lineHeight: "2.75rem"
    letterSpacing: "-0.025em"
  display:
    fontFamily: "system-ui"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "system-ui"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.625rem"
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.375rem"
    letterSpacing: "-0.01em"
  strong:
    fontFamily: "system-ui"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  body:
    fontFamily: "system-ui"
    fontSize: "0.8125rem"
    lineHeight: "1.25rem"
  label:
    fontFamily: "system-ui"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  caption:
    fontFamily: "system-ui"
    fontSize: "0.6875rem"
    lineHeight: "1rem"
  micro:
    fontFamily: "system-ui"
    fontSize: "0.65625rem"
    fontWeight: 500
    lineHeight: "0.875rem"
    letterSpacing: "0.01em"
rounded:
  control: "6px"
  card: "10px"
  panel: "14px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "6px 12px"
  button-secondary:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "32px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.night-ink}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "4px 12px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.lamp-done}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
---

# Design System: Specrails Desktop

## Overview

**Creative North Star: "Signal box at night"**

Specrails is a dispatch desk for specs travelling down rails to delivery. The chrome is quiet, dense and precise, like a railway signal panel: hairlines instead of fills, tabular numerals, small status lamps. Colour is spent in exactly two places: on lamps (state) and on the moving spec (the brand gradient). Everything else is ink on night.

The one authored motion is rail travel: a pill decelerating along a hairline track. It means "work is moving" while things run and "arrived" when work ships. All other motion is 100 to 200 ms state feedback. The app is a native desktop tool used for long sessions, so density and calm beat spectacle; peaks are reserved for three proportionate arrivals (PR created, Flow handed off, job completed).

**Key Characteristics:**
- Dark-first, six selectable themes sharing one token contract (see Colors).
- Hierarchy from a role-based type scale and numerals, not from weight alone.
- Status is a lamp (dot plus label), never colour alone.
- Hairline borders and edge highlights create depth; shadows are structural, not decorative.
- The system UI sans only; monospace is for IDs, code and logs.

## Colors

A night-ink neutral base with one cyan signal, a violet rail end, and a closed set of lamp hues. Values below are the default `specrails` theme; every other theme redefines the same semantic tokens in `client/src/globals.css`, with JS-side palettes (terminal, charts) mirrored in `client/src/features/settings/lib/themes.ts`.

### Primary
- **Signal Cyan** (hsl(187 100% 44%)): primary actions, focus ring, the leading half of the rail pill and RailMark gradient, the active station.

### Secondary
- **Rail Violet** (hsl(280 45% 62%)): the trailing end of the rail gradient (`--color-rail-end`). Never used as a fill on its own surface.

### Tertiary (lamps)
- **Running Periwinkle** (hsl(234 92% 76%)): running and in-flight work, kept apart from the cyan primary.
- **Done Emerald** (hsl(152 78% 48%)): completed, healthy.
- **Caution Amber** (hsl(42 92% 58%)): caution and cost only. Not review, not priority.
- **Failed Tomato** (hsl(12 80% 55%)): failures and destructive actions.
- **Review Orchid** (hsl(322 55% 72%)): the review lamp, so amber stays unambiguous. Themes whose primary is violet (Dracula, Aurora Light, Obsidian Dark) use their own pink for the review lamp instead (it also stays clear of Flow teal).
- **Flow Teal** (hsl(170 78% 50%)): Flow mode identity.

### Lamp canon
One state, one token, on every surface (chips, badges, pills, cards).

| Lamp | Token |
| --- | --- |
| running | `accent-info` |
| done | `accent-success` |
| caution | `accent-warning` |
| failed | `destructive` |
| review | `accent-review` |
| flow | `accent-flow` |
| primary | `primary` / `accent-primary` |

`accent-review` must sit at least 60° of hue from `accent-primary` (and 40° from `accent-secondary`) with 4.5:1 text contrast on the card in every theme; a test enforces it.

### Neutral
- **Night Ink** (hsl(240 33% 4%)): app background. **Deep Ink** (hsl(240 40% 2%)) for sidebars and code.
- **Panel** (hsl(240 30% 8%)) cards; **Surface** (hsl(238 28% 11%)) cards-on-card; **Chrome** (hsl(238 22% 16%)) interactive chrome and hover.
- **Hairline** (hsl(240 25% 100% / 0.14)): every border.
- **Ink** (hsl(240 20% 95%)) text; **Muted Ink** (hsl(240 13% 62%)) secondary text, at least 4.5:1 on panel.

### Theme characters
- **specrails**: night signal box, indigo-black with cyan lamps.
- **aurora-light**: daylight drafting table, paper and ink, elevation by shadow rather than tint.
- **obsidian-dark**: graphite pro, neutral hue 220 at 8% saturation or less, a single desaturated violet accent.
- **dracula**: fidelity to the official palette is the feature; tokens only.
- **code-rain**: phosphor CRT; the only theme where monospace is the display voice, sharp radii, glowing lamps.
- **galaxy**: deep space with a blue blade; the rail pill runs blue to signal gold.

### Named Rules
**The Lamp Rule.** Colour belongs to state. If a hue is not a lamp, the gradient, or the single primary action, it is not on the screen.

**The Amber Rule.** Amber means caution or cost. Review has its own lamp; priority follows the status canon.

**The Gradient Reservation Rule.** The cyan-to-violet gradient appears only on the RailMark and the travelling pill. No gradient text, no gradient cards.

## Typography

**Display / Body / Label Font:** the platform UI sans (`system-ui`: SF Pro on macOS, Segoe UI Variable on Windows).
**Mono:** `ui-monospace`, for IDs, code, logs and terminal only (code-rain also uses it for display roles via `--font-display`).

**Character:** native and precise. Real steps in size and weight, tight tracking on large sizes, tabular numerals wherever numbers align.

### Hierarchy
Tailwind utilities `text-micro` through `text-display-xl` come from `--text-*` tokens.
- **Display XL** (600, 2.5rem/2.75rem, -0.025em): hero numerals only.
- **Display** (600, 1.75rem/2rem, -0.02em): analytics figures, mission home.
- **Headline** (600, 1.25rem/1.625rem, -0.015em): page titles.
- **Title** (600, 1rem/1.375rem, -0.01em): section and card titles.
- **Strong** (600, 0.875rem/1.25rem): emphasised rows.
- **Body** (400, 0.8125rem/1.25rem): default text; keep prose to 65 to 75ch.
- **Label** (500, 0.75rem/1rem): controls and form labels.
- **Caption** (400, 0.6875rem/1rem) and **Micro** (500, 0.65625rem/0.875rem, +0.01em): metadata text. Micro (10.5 px) is badge-only; readable text is 11 px or larger.

### Named Rules
**The Role Rule.** Pick a role token, never a raw `text-[Npx]`. Hierarchy comes from the step between roles.

**The Numerals Rule.** Counts, durations, costs and timestamps use tabular numerals.

## Layout

A dense three-zone desktop shell: project rail and sidebar on the left, the working surface in the centre, optional detail panels on the right. Density is deliberate: 4 px base unit, 8 to 16 px inside controls and cards, 24 px between sections. Group tightly, separate generously, and give headings more space above than below. Project switching keeps cached data on screen while it refreshes. Layouts collapse to a single column below the tablet breakpoint (the companion and web views rely on it); no fixed-width assumptions on text.

## Elevation & Depth

A hybrid of hairlines and three structural shadows. At rest a surface is defined by a 1 px hairline and a faint top edge highlight; shadows arrive for lifted layers (popovers, dialogs). Light themes drop the edge highlight and let shadow do the separating.

### Shadow Vocabulary
- **Shadow 1** (`0 1px 2px var(--shadow-color), var(--edge-highlight)`): cards and resting panels.
- **Shadow 2** (`0 6px 16px -4px var(--shadow-color), var(--edge-highlight)`): menus, popovers, hovered cards.
- **Shadow 3** (`0 24px 64px -16px var(--shadow-color-strong), 0 0 0 1px var(--color-border)`): dialogs and floating panels.
- **Edge highlight** (`inset 0 1px 0 hsl(0 0% 100% / 0.04)`; `none` in aurora-light).

### Named Rules
**The Flat-At-Rest Rule.** Resting surfaces get hairline plus shadow 1 at most. A bigger shadow means the layer floats.

**The No-Halo Rule.** Shadows carry an offset and a soft blur; zero-offset colour halos are limited to code-rain, where glow is the theme.

## Shapes

Four radius roles, each overridable per theme: **control** 6 px (buttons, inputs, chips), **card** 10 px, **panel** 14 px (dialogs, composer, floating panels), **pill** 9999 px (badges, lamps, rail pill). Code-rain sharpens them. Legacy Tailwind radius (`rounded-sm` to `rounded-3xl`) and shadow (`shadow-sm` to `shadow-2xl`) utilities are aliased to these roles in `@theme`, so they follow the theme; `rounded-full` and `shadow-none` are untouched. The display roles (`text-headline`, `text-display`, `text-display-xl`) use `--font-display`. Borders are always one hairline; no coloured side-borders.

Motion tokens: `--ease-out` (0.16, 1, 0.3, 1), `--ease-rail` (0.22, 0.9, 0.25, 1); durations instant 100 ms, fast 150, base 200, slow 300, peak 640 (arrival moments only). All motion respects `prefers-reduced-motion`, and Settings ▸ Appearance ▸ Reduce motion (system / reduce / full) overrides the OS through `<html data-motion>` and `hooks/useReducedMotion`. The override reaches CSS too: Tailwind's `motion-safe:` / `motion-reduce:` are redefined in `globals.css` and every hand-written `@media (prefers-reduced-motion)` block is scoped with `:root:not([data-motion=...])` plus an explicit `:root[data-motion=...]` twin (guarded by `lib/__tests__/motion-override-guard.test.ts`). Density (comfortable / compact) is the `--density-*` variable set on `<html data-density>`: cards, rows and the job story read it; components never fork per density.

## Components

### Buttons
- **Shape:** control radius (6 px), 32 px high (28 px small, 40 px large).
- **Primary:** Signal Cyan fill with Night Ink text; **Secondary:** Chrome fill; **Outline** and **Ghost** use hairline and accent hover.
- **Hover / Focus:** colour shift in 150 ms; press scales to 0.98 in 100 ms; focus shows a 2 px ring in the primary.

### Badges and lamps
- **Style:** pill, transparent fill, 30% tinted hairline, a 6 px leading dot in the lamp colour, micro text.
- **State:** success, running, warning, review, failed, queued, canceled. `LiveDot` adds a soft 2 s ring only while work is live.

### Cards / Containers
- **Corner Style:** card radius (10 px); panel radius for dialogs.
- **Background:** Panel; nested content on Surface. Never nest cards inside cards.
- **Shadow Strategy:** shadow 1 at rest.
- **Internal Padding:** 16 px.

### Inputs / Fields
- **Style:** 32 px, control radius, hairline input border on Night Ink.
- **Focus:** primary ring; placeholder in Muted Ink; disabled at 50%.

### Rail track and RailMark (signature)
- **RailTrack:** a hairline with an optional gradient pill (cyan to the theme's rail end) and station lamps (pending, active, done, failed). Indeterminate it travels with `--ease-rail`; determinate it sits at progress. It replaces spinners wherever work is in flight.
- **RailMark:** the brand glyph with the same gradient; the identity of Mission Control, the boot splash and the shell.
- **Theme picker:** each card previews its theme through a live mini rail (track, lamps, pill) in that theme's own palette.

## Do's and Don'ts

### Do:
- **Do** use the role tokens for type (`text-body`, `text-title`), radius (`rounded-card`) and elevation (`shadow-1/2/3`).
- **Do** express state as a lamp with a label, and reserve amber for caution and cost.
- **Do** show running work as a travelling rail pill and finish with a proportionate arrival moment.
- **Do** keep every text pair at 4.5:1 and every lamp at 3:1 in all six themes.
- **Do** add new copy to all eight locales and add new semantic tokens to every `[data-theme]` block.

### Don't:
- **Don't** introduce spinners, bouncing dots or a second ping implementation; use `LiveDot` or `RailTrack`. Exception: a 12–14 px `Loader2` inside a pending button is allowed; content-area waits use `<RailTrack running />` (indeterminate) or `Skeleton`.
- **Don't** use gradient text, glass as decoration, hard offset shadows or coloured side-borders.
- **Don't** pick random radii or `shadow-sm` to `2xl`; use the four radius and three elevation roles.
- **Don't** use monospace to look technical, and don't swap the system sans for a decorative face.
- **Don't** colour a status by hue alone; pair it with a dot and text.
