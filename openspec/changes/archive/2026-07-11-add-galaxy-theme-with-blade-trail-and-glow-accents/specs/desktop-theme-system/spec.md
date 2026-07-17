## MODIFIED Requirements

### Requirement: App-wide theme catalog

The app SHALL ship with exactly six built-in themes selectable by the user: `dracula` (default at first install), `aurora-light`, `obsidian-dark`, `code-rain`, `specrails` (the current default), and `galaxy`. Each theme MUST define a complete palette covering background, foreground, surfaces, semantic accents (primary, secondary, info, success, warning, danger, highlight), borders, and muted variants. Theme identifiers MUST be kebab-case strings drawn from a closed allow-list enforced on both client and server. Legacy identifiers MAY be translated only by read-side migration paths and MUST NOT be accepted by new write requests.

#### Scenario: Default theme is Dracula on a fresh install
- **WHEN** the app is launched for the first time and no `ui_theme` row exists in `desktop_settings`
- **THEN** the active theme is `dracula` and the database is seeded with `ui_theme = 'dracula'`

#### Scenario: Unknown theme identifier is rejected
- **WHEN** the client or an external caller attempts to PATCH the theme to a value outside the current allow-list
- **THEN** the server responds with HTTP 400 and the persisted value is unchanged

#### Scenario: Code Rain is visually distinct from the other dark themes
- **WHEN** the active theme is `code-rain`
- **THEN** the background is a near-black green-tinted hue distinct from Dracula's purple-tinted, Obsidian Dark's blue-tinted, SpecRails's navy-indigo, and Galaxy's deep-space dark surfaces, and the primary accent is an unmistakable phosphor green (hue in the green band, lightness >= 50%), differentiated enough that a user can tell the dark themes apart side-by-side

#### Scenario: Galaxy is visually distinct from the other dark themes
- **WHEN** the active theme is `galaxy`
- **THEN** the background is a neutral deep-space near-black hue distinct from Dracula's purple-tinted, Obsidian Dark's blue-tinted, Code Rain's green-tinted, and SpecRails's navy-indigo dark surfaces, and the primary accent is an unmistakable saturated blue (hue in the blue band, lightness >= 55%) paired with a saturated red destructive accent (hue in the red band), differentiated enough that a user can tell the dark themes apart side-by-side

### Requirement: No flash of wrong theme on app boot

On every app page load, the document root SHALL have its `data-theme` attribute set to the user's chosen theme before the React application hydrates. The chosen theme value SHALL be cached in `localStorage` under a documented key whenever the server-side value changes. The anti-FOUC boot allow-list SHALL recognize every current built-in theme id that can be selected by the app, including `galaxy` and `code-rain`, and the inline splash screen SHALL define matching pre-React splash variables for every current built-in theme that may be applied by the boot script. If localStorage contains a legacy theme id, the boot script SHALL translate it to the current id and rewrite localStorage before applying `data-theme`.

#### Scenario: Returning Galaxy user sees Galaxy on first paint
- **WHEN** `localStorage.getItem('specrails-desktop:ui-theme')` returns `star-wars` before React hydrates
- **THEN** the anti-FOUC boot script rewrites the value to `galaxy` and applies `document.documentElement.dataset.theme = 'galaxy'` instead of falling back to another theme

#### Scenario: Returning Code Rain user sees Code Rain on first paint
- **WHEN** `localStorage.getItem('specrails-desktop:ui-theme')` returns `matrix` before React hydrates
- **THEN** the anti-FOUC boot script rewrites the value to `code-rain` and applies `document.documentElement.dataset.theme = 'code-rain'` instead of falling back to another theme

#### Scenario: Galaxy splash variables are available before React hydrates
- **WHEN** the boot script applies `html[data-theme="galaxy"]` and the inline splash screen renders
- **THEN** the splash screen resolves Galaxy-specific background, foreground, primary, secondary, and muted variables from `client/index.html`

### Requirement: Theme persistence in app settings

The active theme SHALL be persisted in the `desktop_settings` table under the key `ui_theme`. The server SHALL expose endpoints to read and update this value. The persisted value SHALL survive server restarts and be the authoritative source in cross-device usage. Read paths SHALL translate persisted legacy ids to their current ids and persist the translated id back to the database when possible.

#### Scenario: GET returns the persisted theme
- **WHEN** a client issues `GET /api/theme`
- **THEN** the server responds with `{ "theme": "<persisted-current-value>" }` and HTTP 200

#### Scenario: GET migrates a legacy Galaxy value
- **WHEN** `desktop_settings.ui_theme` is `star-wars` and a client issues `GET /api/theme`
- **THEN** the server responds with `{ "theme": "galaxy" }`, persists `ui_theme = 'galaxy'`, and does not expose the legacy id

#### Scenario: GET migrates a legacy Code Rain value
- **WHEN** `desktop_settings.ui_theme` is `matrix` and a client issues `GET /api/theme`
- **THEN** the server responds with `{ "theme": "code-rain" }`, persists `ui_theme = 'code-rain'`, and does not expose the legacy id

#### Scenario: PATCH updates the persisted theme
- **WHEN** a client issues `PATCH /api/theme` with body `{ "theme": "galaxy" }`
- **THEN** the server persists the value to `desktop_settings`, responds with HTTP 200 and the new value, and a subsequent GET returns the same value

#### Scenario: PATCH rejects legacy theme ids
- **WHEN** a client issues `PATCH /api/theme` with a legacy theme id
- **THEN** the server responds with HTTP 400 and the persisted value is unchanged

### Requirement: Code Rain glow effect is motion-aware

The `code-rain` theme MAY apply a subtle drop-shadow glow effect to interactive surfaces that already key off `accent-primary` (focus rings, primary buttons, hover states on rails). When applied, the glow MUST be gated behind `@media (prefers-reduced-motion: no-preference)` so users who request reduced motion do not receive the glow. The glow MUST be expressed via CSS variables so component code remains theme-agnostic; components MUST NOT branch on theme identifier to enable or disable the glow.

#### Scenario: Glow is suppressed under reduced-motion preference
- **WHEN** the active theme is `code-rain` and the user agent reports `prefers-reduced-motion: reduce`
- **THEN** no element renders the Code Rain glow drop-shadow

#### Scenario: Component code does not branch on theme identifier
- **WHEN** a regression check runs a theme-id search in component code excluding the theme registry, palette maps, Appearance settings card, and dedicated theme-effects directory
- **THEN** `code-rain` appears only in the allowed theme infrastructure and not in unrelated component branches

### Requirement: Galaxy palette definition

The `galaxy` theme SHALL define a neutral deep-space near-black background, a saturated blue accent shared by `accent-primary`, `ring`, and `accent-info`, a steel-gray/silver `accent-secondary`, a saturated red `destructive` accent, a gold `accent-highlight`, and a green `accent-success`, plus a full xterm terminal palette, a 5-color Recharts chart palette, and job-status colors, following the exact `ThemeDescriptor` shape used by every other built-in theme. The Galaxy palette MUST be visually identical to the existing pre-rename decorative theme values and visually distinct from the `specrails` theme.

#### Scenario: Galaxy descriptor defines all required fields
- **WHEN** `THEMES['galaxy']` is inspected
- **THEN** it has `displayName`, `tagline`, `scheme: 'dark'`, `previewSwatches`, a full 20-key `xterm` palette, a 5-entry `chart` palette with unique colors, and a `status` map covering `completed`, `failed`, `canceled`, `running`, and `queued`

#### Scenario: Primary, ring, and info share a distinct saturated blue hue
- **WHEN** the active theme is `galaxy`
- **THEN** `accent-primary`, `ring`, and `accent-info` all resolve to the same blue hue in the 212-215 degree range, distinct from the resolved `destructive` red, `accent-highlight` gold, `accent-success` green, and SpecRails cyan primary hues

#### Scenario: Background is neutral deep-space black, not SpecRails navy
- **WHEN** the active theme is `galaxy`
- **THEN** the resolved background is a desaturated near-black with saturation around 20% and lightness around 4%, preserving a dark elevation ladder while reading as neutral black rather than SpecRails's saturated navy-indigo

### Requirement: Galaxy theme propagates to non-CSS surfaces

The `galaxy` theme SHALL ship its own xterm.js palette, Recharts series palette, and job-status color map, and these MUST be applied when the active theme is `galaxy` using the same propagation mechanism the existing themes use (`getActiveTheme()` / `theme-palette.ts`, unmodified).

#### Scenario: Galaxy xterm palette is applied to open terminals
- **WHEN** the active theme is switched to `galaxy` while a terminal session is open
- **THEN** the terminal's background, foreground, cursor, and ANSI 16 palette update to the Galaxy terminal palette, scrollback and shell-integration marks are preserved, and the xterm.js `Terminal` instance is the same JavaScript object before and after the switch

#### Scenario: Galaxy chart palette renders multi-series charts legibly
- **WHEN** the active theme is `galaxy` and an analytics page renders a multi-series Recharts chart
- **THEN** the series colors span at least three distinct hue families (blue, red/gold warm sentinel, and green) so adjacent series are visually distinguishable

### Requirement: Blade cursor-trail effect

The `galaxy` theme SHALL ship a decorative `BladeTrail` component that renders a thin, elegant, glowing blade-line trail following the cursor. It MUST be registered only for the `galaxy` theme id in `ThemeEffectLayer`'s `THEME_EFFECTS` map and MUST NOT render under any other active theme. The component MUST NOT branch on a theme identifier internally; `ThemeEffectLayer`'s registry is the only place the association between the theme id and the effect component is made.

#### Scenario: Effect renders only under the Galaxy theme
- **WHEN** the active theme is `galaxy`
- **THEN** `ThemeEffectLayer` mounts `BladeTrail`

#### Scenario: Effect does not render under any other theme
- **WHEN** the active theme is any of `dracula`, `aurora-light`, `obsidian-dark`, `code-rain`, or `specrails`
- **THEN** `ThemeEffectLayer` does not mount `BladeTrail`

#### Scenario: Trail follows the cursor as a thin glowing line, not a glyph field
- **WHEN** `BladeTrail` is mounted and the pointer moves across the viewport
- **THEN** the canvas renders a tapered, glowing polyline tracing recent pointer positions rather than a field of independently falling characters

### Requirement: Blade trail is motion-aware and non-interactive

The `BladeTrail` effect MUST render nothing (no canvas draw output, no animation loop) when the OS-level `prefers-reduced-motion` media query matches `reduce`. It MUST pause its animation loop while `document.hidden` is `true` and resume when the document becomes visible again. Its canvas element MUST be `position: fixed`, `inset: 0`, `pointer-events: none`, and positioned behind app content (`z-index: -1`), so it never intercepts clicks or visually sits above panels.

#### Scenario: Reduced motion suppresses the effect
- **WHEN** the OS reports `prefers-reduced-motion: reduce` and the active theme is `galaxy`
- **THEN** `BladeTrail` performs no canvas drawing and starts no animation frame loop

#### Scenario: Animation pauses while the tab is hidden
- **WHEN** the document becomes hidden while `BladeTrail` is animating
- **THEN** the `requestAnimationFrame` loop is cancelled, and it resumes only after the document becomes visible again

#### Scenario: Canvas never intercepts pointer events or sits above panels
- **WHEN** `BladeTrail` is mounted
- **THEN** its `<canvas>` element has `pointer-events: none` and a `z-index` behind all app content, so clicking anywhere on the page reaches the underlying UI element unaffected

### Requirement: Blade-glow focus and border treatment

Under the `galaxy` theme, focus-visible interactive elements (`button`, `a`, `[role="button"]`, `[role="radio"]`) SHALL render a subtle blade-glow drop-shadow, gated behind `@media (prefers-reduced-motion: no-preference)`, mirroring the existing glow mechanism. Additionally, active/primary-bordered surfaces (elements carrying the app's existing active/selected border marker, e.g. the active nav link and any surface using the `border-accent-primary` selection utility) SHALL render a thin glowing border treatment scoped to `[data-theme="galaxy"]`, so no other theme's styling changes. Both rules MUST be expressed via CSS custom properties / scoped selectors; component code MUST NOT branch on the `galaxy` theme id to enable either effect.

#### Scenario: Focus-visible elements glow under Galaxy
- **WHEN** the active theme is `galaxy`, `prefers-reduced-motion` allows motion, and a button, link, or radio item receives keyboard focus
- **THEN** the focused element renders the Galaxy drop-shadow filter

#### Scenario: Focus glow is suppressed under reduced-motion preference
- **WHEN** the active theme is `galaxy` and the user agent reports `prefers-reduced-motion: reduce`
- **THEN** no element renders the Galaxy focus glow drop-shadow

#### Scenario: Active nav item renders a glowing border
- **WHEN** the active theme is `galaxy` and a navigation link is the current route (carrying `aria-current="page"`)
- **THEN** it renders a thin glowing border treatment distinct from its non-active siblings

#### Scenario: No other theme is affected
- **WHEN** the active theme is any theme other than `galaxy`
- **THEN** none of the Galaxy glow rules apply, and existing focus/border styling for that theme is byte-identical to before this change

### Requirement: Galaxy background effects are visible only in primary work views

The `galaxy` theme SHALL show its global `BladeTrail` cursor effect behind app content in Mission Control and the Specs Board, not only on one board surface. The theme SHALL also show a view-local Starfield background behind Mission Control and the Specs Board. Both effects MUST be scoped to `galaxy`; other themes MUST retain their existing backgrounds and effects.

#### Scenario: Mission Control reveals the Galaxy effects
- **WHEN** the active theme is `galaxy` and Mission Control is rendered
- **THEN** the outer Mission Control page background is transparent enough for the global `BladeTrail` and local Starfield to be visible behind its content
- **AND** readable cards, panes, and controls remain painted above the effects

#### Scenario: Specs Board renders a local Starfield under Galaxy
- **WHEN** the active theme is `galaxy` and the Specs Board dashboard route is rendered
- **THEN** a local Starfield canvas is mounted behind the board content
- **AND** the global `BladeTrail` remains available at the root layer

#### Scenario: Other themes do not receive Galaxy background effects
- **WHEN** the active theme is any theme other than `galaxy`
- **THEN** neither Mission Control nor the Specs Board mounts the Starfield effect
- **AND** Galaxy transparency rules do not apply

## ADDED Requirements

### Requirement: Theme-facing terminology uses current generic names

Theme-facing user strings, exported identifiers, filenames, CSS selectors, comments, and tests SHALL use current generic names for the renamed themes and effects. Required legacy string literals MAY remain only in explicit migration maps and tests that prove migration from persisted old ids.

#### Scenario: User-facing theme copy uses current names
- **WHEN** Settings renders the theme picker and localized setup copy
- **THEN** the renamed themes appear as `Code Rain` and `Galaxy` with generic taglines that do not reference old branded phrasing

#### Scenario: Theme effect components use generic filenames and exports
- **WHEN** the theme-effects directory is inspected
- **THEN** the cursor trail component is exported from `BladeTrail.tsx`, the terminal-rain component is exported from `CodeRainEffect.tsx`, and `ThemeEffectLayer.tsx` imports those names

#### Scenario: Stale terminology search is clean outside migration evidence
- **WHEN** a regression search scans client and server files touched by this ticket
- **THEN** old branded theme names and component terms appear only in the legacy migration map and migration-specific tests
