## MODIFIED Requirements

### Requirement: App-wide theme catalog

The app SHALL ship with exactly six built-in themes selectable by the user: `dracula` (default at first install), `aurora-light`, `obsidian-dark`, `matrix`, `specrails` (the current default), and `star-wars`. Each theme MUST define a complete palette covering background, foreground, surfaces, semantic accents (primary, secondary, info, success, warning, danger, highlight), borders, and muted variants. Theme identifiers MUST be kebab-case strings drawn from a closed allow-list enforced on both client and server.

#### Scenario: Default theme is Dracula on a fresh install
- **WHEN** the app is launched for the first time and no `ui_theme` row exists in `desktop_settings`
- **THEN** the active theme is `dracula` and the database is seeded with `ui_theme = 'dracula'`

#### Scenario: Unknown theme identifier is rejected
- **WHEN** the client or an external caller attempts to PATCH the theme to a value outside the allow-list
- **THEN** the server responds with HTTP 400 and the persisted value is unchanged

#### Scenario: Aurora Light preserves brand identity
- **WHEN** the active theme is `aurora-light`
- **THEN** the primary accent remains a purple/indigo hue (preserving brand recognition) while the background is a warm or neutral off-white (not pure `#ffffff`) and all text/background pairs meet WCAG AA contrast for body copy

#### Scenario: Obsidian Dark is visually distinct from Dracula
- **WHEN** the active theme is `obsidian-dark`
- **THEN** the background is a near-black blue-tinted hue distinct from Dracula's purple-tinted dark surface, and the accent palette is differentiated enough that a user can tell the two themes apart side-by-side

#### Scenario: Matrix is visually distinct from the other dark themes
- **WHEN** the active theme is `matrix`
- **THEN** the background is a near-black green-tinted hue distinct from Dracula's purple-tinted, Obsidian Dark's blue-tinted, SpecRails's navy-indigo, and Star Wars's deep-space dark surfaces, and the primary accent is an unmistakable phosphor green (hue in the green band, lightness ≥ 50%), differentiated enough that a user can tell the dark themes apart side-by-side

#### Scenario: Star Wars is visually distinct from the other dark themes
- **WHEN** the active theme is `star-wars`
- **THEN** the background is a deep-space near-black blue-tinted hue distinct from Dracula's purple-tinted, Obsidian Dark's blue-tinted, Matrix's green-tinted, and SpecRails's navy-indigo dark surfaces, and the primary accent is an unmistakable saturated blue (hue in the blue band, lightness ≥ 55%) paired with a saturated red destructive accent (hue in the red band), differentiated enough that a user can tell the dark themes apart side-by-side

## ADDED Requirements

### Requirement: Star Wars palette definition

The `star-wars` theme SHALL define a deep-space near-black background, a Jedi-blue accent shared by `accent-primary`, `ring`, and `accent-info`, a Sith-red `destructive` accent, a gold `accent-highlight`, and a Force-green `accent-success`, plus a full xterm terminal palette, a 5-color Recharts chart palette, and job-status colors, following the exact `ThemeDescriptor` shape used by every other built-in theme.

#### Scenario: Star Wars descriptor defines all required fields
- **WHEN** `THEMES['star-wars']` is inspected
- **THEN** it has `displayName`, `tagline`, `scheme: 'dark'`, `previewSwatches`, a full 20-key `xterm` palette, a 5-entry `chart` palette with unique colors, and a `status` map covering `completed`, `failed`, `canceled`, `running`, and `queued`

#### Scenario: Primary, ring, and info share the Jedi-blue hue
- **WHEN** the active theme is `star-wars`
- **THEN** `accent-primary`, `ring`, and `accent-info` all resolve to the same blue hue (within a few degrees), distinct from the resolved `destructive` (red), `accent-highlight` (gold), and `accent-success` (green) hues

#### Scenario: Destructive is an unmistakable Sith red
- **WHEN** the active theme is `star-wars`
- **THEN** the resolved `destructive` / `accent-destructive`-equivalent hue sits in the red band (hue 340°–10°), distinct from the gold highlight and the blue primary

### Requirement: Star Wars theme propagates to non-CSS surfaces

The `star-wars` theme SHALL ship its own xterm.js palette, Recharts series palette, and job-status color map, and these MUST be applied when the active theme is `star-wars` using the same propagation mechanism the existing five themes use (`getActiveTheme()` / `theme-palette.ts`, unmodified).

#### Scenario: Star Wars xterm palette is applied to open terminals
- **WHEN** the active theme is switched to `star-wars` while a terminal session is open
- **THEN** the terminal's background, foreground, cursor, and ANSI 16 palette update to the Star Wars terminal palette, scrollback and shell-integration marks are preserved, and the xterm.js `Terminal` instance is the same JavaScript object before and after the switch

#### Scenario: Star Wars chart palette renders multi-series charts legibly
- **WHEN** the active theme is `star-wars` and an analytics page renders a multi-series Recharts chart
- **THEN** the series colors span at least three distinct hue families (blue, red/gold warm sentinel, and green) so adjacent series are visually distinguishable

### Requirement: Lightsaber cursor-trail effect

The `star-wars` theme SHALL ship a decorative `LightsaberTrail` component that renders a thin, elegant, glowing blade-line trail following the cursor. It MUST be registered only for the `star-wars` theme id in `ThemeEffectLayer`'s `THEME_EFFECTS` map and MUST NOT render under any other active theme. The component MUST NOT branch on a theme identifier internally — `ThemeEffectLayer`'s registry is the only place the association between the theme id and the effect component is made.

#### Scenario: Effect renders only under the Star Wars theme
- **WHEN** the active theme is `star-wars`
- **THEN** `ThemeEffectLayer` mounts `LightsaberTrail`

#### Scenario: Effect does not render under any other theme
- **WHEN** the active theme is any of `dracula`, `aurora-light`, `obsidian-dark`, `matrix`, or `specrails`
- **THEN** `ThemeEffectLayer` does not mount `LightsaberTrail` (it mounts `MatrixRain` only for `matrix`, and nothing for the remaining themes)

#### Scenario: Trail follows the cursor as a thin glowing line, not a glyph field
- **WHEN** `LightsaberTrail` is mounted and the pointer moves across the viewport
- **THEN** the canvas renders a tapered, glowing polyline tracing recent pointer positions rather than a field of independently falling characters

### Requirement: Lightsaber trail is motion-aware and non-interactive

The `LightsaberTrail` effect MUST render nothing (no canvas draw output, no animation loop) when the OS-level `prefers-reduced-motion` media query matches `reduce`. It MUST pause its animation loop while `document.hidden` is `true` and resume when the document becomes visible again. Its canvas element MUST be `position: fixed`, `inset: 0`, `pointer-events: none`, and positioned behind app content (`z-index: -1`), so it never intercepts clicks or visually sits above panels.

#### Scenario: Reduced motion suppresses the effect
- **WHEN** the OS reports `prefers-reduced-motion: reduce` and the active theme is `star-wars`
- **THEN** `LightsaberTrail` performs no canvas drawing and starts no animation frame loop

#### Scenario: Animation pauses while the tab is hidden
- **WHEN** the document becomes hidden (e.g. the user switches tabs or minimizes the window) while `LightsaberTrail` is animating
- **THEN** the `requestAnimationFrame` loop is cancelled, and it resumes only after the document becomes visible again

#### Scenario: Canvas never intercepts pointer events or sits above panels
- **WHEN** `LightsaberTrail` is mounted
- **THEN** its `<canvas>` element has `pointer-events: none` and a `z-index` behind all app content, so clicking anywhere on the page reaches the underlying UI element unaffected

### Requirement: Blade-glow focus and border treatment

Under the `star-wars` theme, focus-visible interactive elements (`button`, `a`, `[role="button"]`, `[role="radio"]`) SHALL render a subtle blade-glow drop-shadow, gated behind `@media (prefers-reduced-motion: no-preference)`, mirroring the existing `--matrix-glow` mechanism. Additionally, active/primary-bordered surfaces (elements carrying the app's existing "active/selected" border marker, e.g. the active nav link and any surface using the `border-accent-primary` selection utility) SHALL render a thin glowing border treatment scoped to `[data-theme="star-wars"]`, so no other theme's styling changes. Both rules MUST be expressed via CSS custom properties / scoped selectors — component code MUST NOT branch on the `star-wars` theme id to enable either effect.

#### Scenario: Focus-visible elements glow under Star Wars
- **WHEN** the active theme is `star-wars`, `prefers-reduced-motion` allows motion, and a button, link, or radio item receives keyboard focus
- **THEN** the focused element renders the `--starwars-glow` drop-shadow filter

#### Scenario: Focus glow is suppressed under reduced-motion preference
- **WHEN** the active theme is `star-wars` and the user agent reports `prefers-reduced-motion: reduce`
- **THEN** no element renders the Star Wars focus glow drop-shadow

#### Scenario: Active nav item renders a glowing border
- **WHEN** the active theme is `star-wars` and a navigation link is the current route (carrying `aria-current="page"`)
- **THEN** it renders a thin glowing border treatment distinct from its non-active siblings

#### Scenario: Active/selected card surfaces render a glowing border
- **WHEN** the active theme is `star-wars` and a surface carries the app's existing `border-accent-primary` active/selected marker (e.g. a selected theme card, a selected rail, a selected ticket row)
- **THEN** it renders a thin glowing border treatment, while the same surface under any other theme renders its existing (non-glowing) selected-border styling unchanged

#### Scenario: No other theme is affected
- **WHEN** the active theme is any theme other than `star-wars`
- **THEN** none of the Star Wars glow rules apply, and existing focus/border styling for that theme is byte-identical to before this change
