# desktop-theme-system Specification

## Purpose
TBD - created by archiving change add-hub-theme-system (capability renamed to desktop-theme-system in the Specrails Desktop rebrand). Update Purpose after archive.
## Requirements
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

### Requirement: Semantic CSS-variable token system

All client component code SHALL reference colors exclusively through semantic Tailwind tokens (e.g. `accent-primary`, `accent-success`, `surface`, `background-deep`). Brand-named tokens (`dracula-*`) MUST NOT appear in any source file under `client/src/` after this change ships. Adding a new theme MUST require zero changes to component code.

#### Scenario: No brand-named tokens leak into components
- **WHEN** a regression check runs `grep -rn "dracula-" client/src --include="*.ts" --include="*.tsx" --include="*.css"`
- **THEN** the command returns zero matches

#### Scenario: Adding a fourth theme touches only theme files
- **WHEN** a developer adds a hypothetical `solarized-dawn` theme by appending one entry to the theme registry, one CSS override block, and one xterm/chart palette
- **THEN** the theme is selectable in Settings and renders correctly without modifying any component file

### Requirement: Theme persistence in app settings

The active theme SHALL be persisted in the `desktop_settings` table under the key `ui_theme`. The server SHALL expose endpoints to read and update this value. The persisted value SHALL survive server restarts and be the authoritative source in cross-device usage.

#### Scenario: GET returns the persisted theme
- **WHEN** a client issues `GET /api/theme`
- **THEN** the server responds with `{ "theme": "<persisted-value>" }` and HTTP 200

#### Scenario: PATCH updates the persisted theme
- **WHEN** a client issues `PATCH /api/theme` with body `{ "theme": "obsidian-dark" }`
- **THEN** the server persists the value to `desktop_settings`, responds with HTTP 200 and the new value, and a subsequent GET returns the same value

#### Scenario: Theme survives server restart
- **WHEN** the user sets theme to `aurora-light` and the server is restarted
- **THEN** on the next boot the persisted theme remains `aurora-light` and is returned by `GET /api/theme`

### Requirement: Theme switching is instantaneous and re-render-free

Theme switches SHALL be applied by mutating `data-theme` on the document root element. The CSS-variable resolution mechanism MUST update all themed surfaces in a single repaint without remounting React subtrees, recreating xterm instances, or re-issuing chart computations beyond a single palette refresh.

#### Scenario: Switching theme does not unmount terminals
- **WHEN** the user switches theme while a terminal session is open with active scrollback
- **THEN** the terminal scrollback, command marks, and shell-integration state are preserved, and the terminal instance is the same JavaScript object before and after the switch

#### Scenario: Switching theme repaints CSS in one frame
- **WHEN** the theme is changed
- **THEN** within the next paint frame all CSS-var-driven surfaces (cards, text, borders, backgrounds) reflect the new theme, with no visible flash of an intermediate state

### Requirement: No flash of wrong theme on app boot

On every app page load, the document root SHALL have its `data-theme` attribute set to the user's chosen theme before the React application hydrates. The chosen theme value SHALL be cached in `localStorage` under a documented key whenever the server-side value changes.

#### Scenario: Returning user sees their theme on first paint
- **WHEN** a user with `ui_theme = 'aurora-light'` loads the app UI
- **THEN** the very first painted frame shows Aurora Light styling, with no Dracula flash

#### Scenario: localStorage cache mirrors server value
- **WHEN** the user changes theme via Settings
- **THEN** `localStorage.getItem('specrails-desktop:ui-theme')` returns the new theme identifier before the next page reload

#### Scenario: Corrupt localStorage value falls back to default
- **WHEN** `localStorage` contains a value not in the theme allow-list (or throws on access)
- **THEN** the boot script applies `dracula` and the application proceeds without error

#### Scenario: Server value wins over stale cache
- **WHEN** the cached localStorage value differs from the server-persisted value (e.g. user changed theme on another machine)
- **THEN** after the React app fetches the server value it updates `data-theme` and overwrites the localStorage cache

### Requirement: Theme propagates to non-CSS rendering surfaces

The active theme SHALL be applied consistently to surfaces that render outside the CSS-variable cascade: xterm.js terminals, Recharts analytics charts, the LogViewer syntax highlighting, and the demo-mode tour overlay.

#### Scenario: Terminal palette matches active theme
- **WHEN** the active theme changes
- **THEN** every open xterm session updates its background, foreground, cursor, and ANSI 16 palette to the new theme's terminal palette without losing scrollback or shell-integration marks

#### Scenario: Charts repaint in the new palette
- **WHEN** the active theme changes while an analytics page is mounted
- **THEN** all Recharts series, axes, gridlines, and tooltips repaint using the new theme's chart palette

#### Scenario: Log syntax highlighting follows theme
- **WHEN** the active theme is `aurora-light` and a log file is rendered in `LogViewer`
- **THEN** keyword, string, comment, and error tokens use the light-theme syntax palette and remain legible against the light background

#### Scenario: Demo tour overlay matches theme
- **WHEN** the user starts the demo tour under any active theme
- **THEN** the tour overlay backdrop, callout cards, and highlight rings render in colors consistent with the active theme

### Requirement: Appearance section in app global settings

The `GlobalSettingsPage` modal SHALL expose an "Appearance" section that lists the four built-in themes as selectable, visually rich preview cards. The currently active theme MUST be visually marked. Selecting a card MUST persist the choice and apply the theme immediately. The section MUST NOT offer hover-based live preview in v1.

#### Scenario: All four themes are listed
- **WHEN** the user opens the app Settings modal and navigates to Appearance
- **THEN** exactly four cards are visible, one per built-in theme, each showing a swatch preview, the theme name, and a short tagline

#### Scenario: Active theme is marked
- **WHEN** the user opens the Appearance section
- **THEN** the card corresponding to the persisted `ui_theme` value is visually marked as selected (e.g. ring, check icon, or filled state)

#### Scenario: Selecting a card applies and persists the theme
- **WHEN** the user clicks a non-active theme card
- **THEN** within the same frame the document root's `data-theme` is updated, the server `PATCH /api/theme` is called with the new value, the localStorage cache is updated, and the card becomes the marked selection

#### Scenario: Server failure surfaces an error and reverts UI
- **WHEN** the user selects a theme and the server PATCH fails (network error or rejection)
- **THEN** the UI reverts the visual selection to the previously active theme and displays a recoverable error message

### Requirement: Theme system is app-wide only

The active theme SHALL apply uniformly across all projects within a single app instance. Projects MUST NOT be able to override the theme. Switching the active project MUST NOT change the theme.

#### Scenario: Theme persists across project switches
- **WHEN** the user sets theme to `obsidian-dark` and then switches between projects in the app
- **THEN** every project's UI renders under `obsidian-dark` and no theme change occurs during the project switch

### Requirement: Matrix palette readability and contrast

The `matrix` theme SHALL meet WCAG AA contrast ratios for body copy (≥ 4.5:1) and UI components / large text (≥ 3:1) against its backgrounds. Body foreground MUST NOT be pure phosphor green; it MUST be a desaturated mint-class color (lightness ≥ 85%) so that long-form reading (streaming Claude logs, ticket descriptions, spec drafts) does not produce chromatic vibration against the green-tinted dark backgrounds.

#### Scenario: Body copy meets WCAG AA on every surface
- **WHEN** the active theme is `matrix` and any body-copy text is rendered on `background`, `surface`, `card`, or `muted` surfaces
- **THEN** the foreground/background contrast ratio is at least 4.5:1

#### Scenario: Body foreground is mint, not pure green
- **WHEN** the active theme is `matrix`
- **THEN** the resolved `--foreground` CSS variable has a saturation lower than the resolved `--accent-primary` (i.e. text reads as a soft mint, not the saturated phosphor-green reserved for accents)

### Requirement: Matrix semantic accent slots remain visually distinct

The six semantic accent slots (`accent-primary`, `accent-info`, `accent-success`, `accent-secondary`, `accent-warning`, `accent-highlight`) plus `destructive` SHALL each be visually distinguishable under the `matrix` theme. The slots MUST NOT all be drawn from a single narrow green ramp; the palette MUST span multiple hue families so that status filter chips, sort controls, priority pills, draft pills, épica badges, and delete affordances remain individually recognizable.

#### Scenario: Warning, highlight, and destructive use warm hues
- **WHEN** the active theme is `matrix`
- **THEN** `accent-warning`, `accent-highlight`, and `destructive` resolve to warm hues (amber / gold / rose family) rather than additional shades of green

#### Scenario: Info is teal, not green
- **WHEN** the active theme is `matrix`
- **THEN** `accent-info` resolves to a teal/cyan hue distinct from both `accent-primary` and `accent-success`

#### Scenario: Primary and secondary are differentiated by lightness within the green family
- **WHEN** the active theme is `matrix`
- **THEN** `accent-primary` and `accent-secondary` both sit in the green hue band, but with a lightness delta of at least 0.15 (HSL L) so they are visibly distinguishable on the same surface

### Requirement: Matrix theme propagates to non-CSS surfaces

The `matrix` theme SHALL ship its own xterm.js palette, Recharts series palette, and LogViewer syntax-highlighting palette, and these MUST be applied when the active theme is `matrix` using the same propagation mechanism the existing three themes use.

#### Scenario: Matrix xterm palette is applied to open terminals
- **WHEN** the active theme is switched to `matrix` while a terminal session is open
- **THEN** the terminal's background, foreground, cursor, and ANSI 16 palette update to the matrix terminal palette, scrollback and shell-integration marks are preserved, and the xterm.js `Terminal` instance is the same JavaScript object before and after the switch

#### Scenario: Matrix chart palette renders multi-series charts legibly
- **WHEN** the active theme is `matrix` and an analytics page renders a multi-series Recharts chart (e.g. daily timeline stacked by surface)
- **THEN** the series colors span at least three distinct hue families (a green, a warm sentinel, and a teal/cyan) so that adjacent series are visually distinguishable

#### Scenario: Matrix LogViewer palette differentiates token classes
- **WHEN** the active theme is `matrix` and a log file is rendered in `LogViewer`
- **THEN** keyword, string, comment, and error tokens use the matrix-mode syntax palette and remain individually distinguishable, with error tokens drawn from the `destructive` rose family

### Requirement: Matrix glow effect is motion-aware

The `matrix` theme MAY apply a subtle drop-shadow glow effect to interactive surfaces that already key off `accent-primary` (focus rings, primary buttons, hover states on rails). When applied, the glow MUST be gated behind `@media (prefers-reduced-motion: no-preference)` so users who request reduced motion do not receive the glow. The glow MUST be expressed via CSS variables so component code remains theme-agnostic — components MUST NOT branch on theme identifier to enable or disable the glow.

#### Scenario: Glow is suppressed under reduced-motion preference
- **WHEN** the active theme is `matrix` and the user agent reports `prefers-reduced-motion: reduce`
- **THEN** no element renders the matrix glow drop-shadow

#### Scenario: Component code does not branch on theme identifier
- **WHEN** a regression check runs `grep -rn "'matrix'\|\"matrix\"" client/src --include="*.tsx" --include="*.ts"` excluding `client/src/lib/themes.ts`, `client/src/lib/theme-palettes.ts`, the Appearance settings card, and the theme-effects directory (`client/src/components/theme-effects/`)
- **THEN** the command returns zero matches in component code (the theme identifier appears only in the theme registry, palette maps, the Settings selector, and the dedicated theme-effects directory whose dispatcher contains the single registry entry per theme)

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

