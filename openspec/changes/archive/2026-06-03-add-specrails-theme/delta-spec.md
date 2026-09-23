# Delta Spec — add-specrails-theme

> This file describes the normative requirements delta for the `hub-theme-system` capability.
> Existing requirements in `openspec/specs/hub-theme-system/spec.md` remain in force.
> This delta adds requirements for the new 'specrails' theme and amends the default theme.

## Capability: hub-theme-system (delta)

### Theme registry

**AMENDED** — The set of built-in themes is now:
- `dracula` (dark)
- `aurora-light` (light)
- `obsidian-dark` (dark)
- `matrix` (dark)
- `specrails` (dark) — **NEW**

**AMENDED** — `DEFAULT_THEME` MUST be `'specrails'`.

### New requirement: specrails theme token contract

The 'specrails' theme MUST define all semantic tokens as follows:

| Token | Value |
|-------|-------|
| `--background` | `hsl(240 35% 4%)` |
| `--card` | `hsl(238 30% 9%)` |
| `--background-deep` | `hsl(240 38% 2%)` |
| `--foreground` | `hsl(240 20% 94%)` |
| `--muted-foreground` | `hsl(240 12% 58%)` |
| `--border` | `hsl(240 20% 100% / 0.08)` |
| `--accent-primary` | `hsl(187 100% 41%)` |
| `--accent-secondary` | `hsl(280 38% 57%)` |
| `--accent-success` | `hsl(152 80% 44%)` |
| `--accent-info` | `hsl(191 97% 50%)` |
| `--accent-warning` | `hsl(42 90% 56%)` |
| `--accent-highlight` | `hsl(248 70% 63%)` |
| `--accent-destructive` | `hsl(12 78% 52%)` |

### Existing requirement (re-stated for clarity)

The `THEME_ID_ALLOWLIST` in `server/hub-router.ts` MUST be kept in sync with `THEME_IDS` in `client/src/features/settings/lib/themes.ts`. Adding a theme to one without the other constitutes a defect.

### Non-regression requirement

Adding the 'specrails' theme MUST NOT alter any token value for the four existing themes. The regression guard (`grep -r 'dracula-'` in CI) continues to apply.

## Capability: specrails-theme (new)

**ID:** `specrails-theme`

**Description:** The specrails brand palette surfaced as a first-class hub theme.

**Requirements:**

1. The theme MUST be selectable from `GlobalSettingsPage > Appearance`.
2. `GET /api/hub/theme` MUST be able to return `{ "theme": "specrails" }`.
3. `PATCH /api/hub/theme` with body `{ "theme": "specrails" }` MUST return 200.
4. `PATCH /api/hub/theme` with body `{ "theme": "specrails_invalid" }` MUST return 400.
5. The theme MUST provide a complete `ThemeDescriptor` including `xterm`, `chart`, `status`, and `previewSwatches`.
6. The theme MUST use `scheme: 'dark'` (correct OS color-scheme hint for dark base).
7. The xterm palette MUST include all 22 required fields from `XtermTheme` (no undefined fields).
8. The `chart` array MUST have exactly 5 elements with no overlap with `destructive`.
