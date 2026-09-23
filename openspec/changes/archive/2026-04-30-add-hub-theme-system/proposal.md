## Why

Hub ships with single hardcoded Dracula palette. Tokens hardcoded as `dracula-*` across 336 component usages, breaking conceptual integrity if non-dracula themes added. Users want choice between premium-quality light and dark themes alongside Dracula. Theme is a first-class personalization axis for a developer dashboard — must look top-tier and feel native, not bolted-on.

## What Changes

- Refactor color tokens from brand-named (`dracula-purple`, `dracula-cyan`, …) to semantic (`accent-primary`, `accent-info`, `accent-success`, `accent-warning`, `accent-danger`, `accent-secondary`, `accent-highlight`, `surface`, `background-deep`, …). **BREAKING** for any external consumer of these Tailwind classes (none known — internal only).
- Introduce theme system with three built-in themes: `dracula` (default, preserves current look 1:1 under new token names), `aurora-light` (premium light, Linear-ish frío profesional), `obsidian-dark` (premium dark, Tokyo-Night-ish negro-azulado, distinct from Dracula).
- Add hub-level setting `ui_theme` persisted in `hub_settings` table; mirrored to `localStorage` for FOUC-free boot.
- Theme selection via `data-theme="<id>"` on `<html>`, with per-theme CSS-var override blocks in `globals.css`. No JS re-render on switch.
- New "Appearance" section in `GlobalSettingsPage` rendering selectable theme cards (visually rich preview swatches, not live-preview-on-hover).
- Bridge theme to non-CSS surfaces: xterm.js terminal palette, Recharts analytics palette, syntax highlighting in `LogViewer`, demo-mode `tour.css`.
- New blocking inline script in `client/index.html` reads `localStorage.ui_theme` and sets `data-theme` before React hydrates, eliminating flash.

## Capabilities

### New Capabilities
- `hub-theme-system`: hub-wide visual theme selection, persistence, and propagation across CSS, terminal, charts, and syntax-highlighting surfaces.

### Modified Capabilities
<!-- None. Existing specs do not pin requirements about theme tokens. The 336 token-rename touches are implementation detail, not spec-level behavior of those capabilities. -->

## Impact

- **Code**: `client/src/globals.css` (full refactor of `@theme inline` + add per-theme blocks), `client/index.html` (FOUC-prevention script), ~60 client component files (Tailwind class rename), `client/src/lib/dracula-colors.ts` + test (rename to `theme-palette.ts`, expose per-theme), `client/src/features/terminals/context/TerminalsContext.tsx` (xterm theme mapping), `client/src/components/analytics/*` (chart palette via CSS vars), `client/src/features/jobs/components/LogViewer.tsx` (syntax theme per active theme), `client/src/demo-mode/tour/tour.css`, `client/src/features/settings/pages/GlobalSettingsPage.tsx` (Appearance section), new `client/src/features/settings/context/ThemeContext.tsx`, new `client/src/features/settings/lib/themes.ts`.
- **Server**: `server/hub-db.ts` (migration adding `ui_theme` default seed under `hub_settings`), `server/hub-router.ts` (GET/PATCH `/api/hub/theme` or extend existing settings endpoint).
- **Tests**: rename `dracula-colors.test.ts` → `theme-palette.test.ts`; new tests for `ThemeContext`, `GlobalSettingsPage` Appearance section, hub theme endpoint, FOUC script behavior.
- **Coverage**: must hold ≥80% server lines/functions/statements and ≥80% client lines/statements per `CLAUDE.md` policy.
- **APIs**: new (or extended) hub settings endpoint surface for theme read/write. No breaking API change to existing endpoints.
- **Dependencies**: none new. Tailwind v4 already supports `[data-theme=...]` selector overrides.
- **Docs**: update `CLAUDE.md` Architecture/Conventions sections briefly noting the theme token system and where to add new themes.
