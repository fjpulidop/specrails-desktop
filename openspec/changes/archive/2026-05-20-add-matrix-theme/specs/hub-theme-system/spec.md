## MODIFIED Requirements

### Requirement: Hub-wide theme catalog

The hub SHALL ship with exactly four built-in themes selectable by the user: `dracula` (default), `aurora-light`, `obsidian-dark`, and `matrix`. Each theme MUST define a complete palette covering background, foreground, surfaces, semantic accents (primary, secondary, info, success, warning, danger, highlight), borders, and muted variants. Theme identifiers MUST be kebab-case strings drawn from a closed allow-list enforced on both client and server.

#### Scenario: Default theme is Dracula on a fresh install
- **WHEN** the hub is launched for the first time and no `ui_theme` row exists in `hub_settings`
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

#### Scenario: Matrix is visually distinct from the other three dark themes
- **WHEN** the active theme is `matrix`
- **THEN** the background is a near-black green-tinted hue distinct from both Dracula's purple-tinted and Obsidian Dark's blue-tinted dark surfaces, and the primary accent is an unmistakable phosphor green (hue in the green band, lightness ≥ 50%), differentiated enough that a user can tell the four dark themes apart side-by-side

### Requirement: Appearance section in hub global settings

The `GlobalSettingsPage` modal SHALL expose an "Appearance" section that lists the four built-in themes as selectable, visually rich preview cards. The currently active theme MUST be visually marked. Selecting a card MUST persist the choice and apply the theme immediately. The section MUST NOT offer hover-based live preview in v1.

#### Scenario: All four themes are listed
- **WHEN** the user opens the hub Settings modal and navigates to Appearance
- **THEN** exactly four cards are visible, one per built-in theme, each showing a swatch preview, the theme name, and a short tagline

#### Scenario: Active theme is marked
- **WHEN** the user opens the Appearance section
- **THEN** the card corresponding to the persisted `ui_theme` value is visually marked as selected (e.g. ring, check icon, or filled state)

#### Scenario: Selecting a card applies and persists the theme
- **WHEN** the user clicks a non-active theme card
- **THEN** within the same frame the document root's `data-theme` is updated, the server `PATCH /api/hub/theme` is called with the new value, the localStorage cache is updated, and the card becomes the marked selection

#### Scenario: Server failure surfaces an error and reverts UI
- **WHEN** the user selects a theme and the server PATCH fails (network error or rejection)
- **THEN** the UI reverts the visual selection to the previously active theme and displays a recoverable error message

## ADDED Requirements

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
- **WHEN** a regression check runs `grep -rn "'matrix'\|\"matrix\"" client/src --include="*.tsx" --include="*.ts"` excluding `client/src/features/settings/lib/themes.ts`, `client/src/lib/theme-palettes.ts`, the Appearance settings card, and the theme-effects directory (`client/src/components/theme-effects/`)
- **THEN** the command returns zero matches in component code (the theme identifier appears only in the theme registry, palette maps, the Settings selector, and the dedicated theme-effects directory whose dispatcher contains the single registry entry per theme)
