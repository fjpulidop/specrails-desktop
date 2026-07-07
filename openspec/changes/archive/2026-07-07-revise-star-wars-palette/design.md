# Design - revise-star-wars-palette

## Context
The branch already contains the original Star Wars theme implementation and its OpenSpec change is archived at `openspec/changes/archive/2026-07-07-add-star-wars-theme/`. The ticket is in review and the latest revision narrows the remaining work to palette re-differentiation only: `STAR_WARS_PALETTE` in `client/src/lib/themes.ts` and the matching `[data-theme="star-wars"]` block in `client/src/globals.css`. The current Star Wars values still collide with SpecRails: background is `hsl(224 45% 5%)` versus SpecRails `hsl(240 33% 4%)`, and secondary is `hsl(280 65% 64%)`, the same hue family as SpecRails `hsl(280 45% 62%)`.

Scope: frontend

## Goal
Make the Star Wars palette visibly distinct from SpecRails while preserving the existing Star Wars theme contract and synchronizing JS and CSS color surfaces.

## Non-Goals
- Do not touch `LightsaberTrail.tsx`, `ThemeEffectLayer.tsx`, `THEME_IDS`, server allow-lists, locale files, docs, or any other theme's palette.
- Do not redesign the Star Wars theme structure, add new tokens, or add a Jedi/Sith variant toggle.
- Do not alter theme picker behavior, persistence, or decorative effect lifecycle.

## Design

### Architecture
The Star Wars theme has two color sources that must stay in sync:

```
client/src/lib/themes.ts       STAR_WARS_PALETTE -> xterm/chart/status/preview
client/src/globals.css         [data-theme="star-wars"] -> CSS variables
```

The developer should update literals in both places in one TDD pass. The rest of the Star Wars feature remains unchanged: the theme id is already registered, effects already dispatch through `ThemeEffectLayer`, and server validation already accepts `star-wars`.

### Data shapes
`STAR_WARS_PALETTE` keeps its current object shape:

```ts
const STAR_WARS_PALETTE = {
  bg: string
  card: string
  bgDeep: string
  fg: string
  muted: string
  primary: string
  info: string
  secondary: string
  success: string
  warning: string
  highlight: string
  destructive: string
} as const
```

Target values should follow these constraints:

```ts
bg:        'hsl(220 20% 4%)'  // neutral deep-space void, not navy
card:      proportional neutral elevation above bg, around 'hsl(220 18% 8%)'
bgDeep:    proportional deeper neutral, around 'hsl(220 24% 2%)'
primary:   hue 212-215, saturated, lightness >= 55
info:      same literal as primary
secondary: low-saturation cool steel-gray/silver, around 'hsl(210 12% 65%)'
```

Keep these existing Star Wars identity accents unchanged unless a test proves a contrast problem:

```ts
success:     'hsl(140 65% 50%)'
warning:     'hsl(28 95% 56%)'
highlight:   'hsl(45 90% 55%)'
destructive: 'hsl(355 92% 56%)'
```

### State & lifecycle
No lifecycle changes. Theme switching, persistence, xterm propagation, chart palettes, and the cursor effect already use the existing theme descriptor and CSS variable mechanisms.

### Public API / surface
No public API change. The externally observable surface is visual:

```ts
THEMES['star-wars'].previewSwatches.background
THEMES['star-wars'].previewSwatches.accents
THEMES['star-wars'].xterm
THEMES['star-wars'].chart
THEMES['star-wars'].status
```

CSS surface:

```css
[data-theme="star-wars"] {
  --color-*;
  --starwars-glow;
}
```

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Palette-only revision | Small review surface; directly satisfies the latest ticket revision; avoids destabilizing an already implemented effect and registry | Leaves any broader Star Wars visual tuning for a later pass | yes |
| Rework Star Wars components/effects too | Could revisit the whole theme experience | Violates the explicit palette-only scope and risks regressions outside the requested delta | no |
| Keep violet secondary | Keeps the original Mace Windu homage | Exact hue-family collision with SpecRails secondary; explicitly rejected by review | no |
| Use steel-gray/silver secondary | Distinct Imperial/Stormtrooper identity; zero overlap with SpecRails violet | Less colorful preview palette | yes |

The chosen approach honors the latest review instruction: fix palette collisions without reopening the already shipped Star Wars feature mechanics.

## Risks
- JS/CSS palette drift could leave preview/xterm/chart surfaces inconsistent with app chrome. Mitigation: add or extend tests and require byte-consistent HSL literals for corresponding Star Wars values.
- Desaturating the background too far could flatten elevation. Mitigation: preserve the same elevation ladder shape with `bg`, `card`, `surface`, `popover`, `muted`, `input`, and `bgDeep` adjusted proportionally.
- Primary blue could remain too close to SpecRails cyan if only lightness changes. Mitigation: test hue separation from SpecRails primary and keep the Star Wars hue around 212-215 degrees.

## Open questions
- None.
