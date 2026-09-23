## Why

The hub ships with three built-in themes (`dracula`, `aurora-light`, `obsidian-dark`) that all read as "modern app chrome." Power users repeatedly ask for a hacker-aesthetic terminal-green theme, both for personal expression and because long sessions spent reading streaming Claude logs benefit from a high-contrast monochromatic anchor. Matrix-inspired theming is a natural fit for the hub's audience (developers running CLI agents over their codebases) and exercises the theme system's "adding a fourth theme is one descriptor + one CSS block" promise.

## What Changes

- Add a fourth built-in theme `matrix` to the hub-wide theme catalog.
- Define a Matrix palette anchored on phosphor green (`#00FF66`) with mint foreground (`#B8FFD9`) on near-black backgrounds, plus warm amber / gold / rose sentinels for warning, highlight, and destructive accents so the six semantic accent slots remain visually distinct.
- Surface the new theme in the Appearance section of `GlobalSettingsPage` alongside the existing three.
- Add `matrix` to the closed allow-list enforced on both the client (`THEME_IDS`) and the server (`PATCH /api/hub/theme` validation).
- Provide matching non-CSS palettes for xterm.js, Recharts, LogViewer syntax highlighting, and the demo-tour overlay so the theme propagates everywhere the existing three do.
- Default theme remains `dracula`. No migration of existing `ui_theme` values; `matrix` is opt-in.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `hub-theme-system`: the built-in catalog grows from three to four themes; the catalog requirement and its scenarios are updated to include `matrix`. The Appearance-section scenario that asserts "exactly three cards" is updated to "exactly four cards."

## Impact

- `client/src/features/settings/lib/themes.ts` — append a `matrix` descriptor and extend the `THEME_IDS` allow-list.
- `client/src/globals.css` — new `[data-theme="matrix"] { ... }` block with the full token contract.
- `client/src/lib/theme-palettes.ts` (or equivalent xterm / Recharts / LogViewer palette maps) — add the matrix-mode palettes.
- `server/hub-router.ts` — extend the server-side theme allow-list.
- No component-code changes (the semantic-token invariant guarantees this).
- No database migration (existing `ui_theme` values stay valid; `matrix` is just a new accepted value).
