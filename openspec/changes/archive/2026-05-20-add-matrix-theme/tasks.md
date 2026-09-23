## 1. Palette definition

- [x] 1.1 Define the matrix palette constants (background ramp, foreground mint, semantic accents, warm sentinels) in `client/src/features/settings/lib/themes.ts` following the same `<NAME>_PALETTE` shape used by Dracula / Aurora / Obsidian.
- [x] 1.2 Verify each accent slot meets the design's distinguishability rules (primary vs secondary lightness delta ≥ 0.15, warm hues for warning/highlight/destructive, teal for info) by walking through the palette in `client/src/features/settings/lib/themes.ts` and adjusting hues until the checklist passes.

## 2. Theme registry

- [x] 2.1 Append a `MATRIX: ThemeDescriptor` entry to `client/src/features/settings/lib/themes.ts` with `id: 'matrix'`, scheme `'dark'`, a display name and tagline, preview swatches, the xterm palette, the Recharts series palette (spanning at least three hue families), and the status map.
- [x] 2.2 Add `'matrix'` to the `THEME_IDS` tuple in `client/src/features/settings/lib/themes.ts`.
- [x] 2.3 Add the entry to the `THEMES` map so `getActiveTheme()` resolves it.

## 3. CSS token contract

- [x] 3.1 Add a `[data-theme="matrix"] { ... }` block to `client/src/globals.css` setting all CSS variables consumed by Tailwind tokens (`--background`, `--background-deep`, `--surface`, `--card`, `--muted`, `--border`, `--foreground`, `--muted-foreground`, `--accent-primary`, `--accent-info`, `--accent-success`, `--accent-secondary`, `--accent-warning`, `--accent-highlight`, `--destructive`, etc.).
- [x] 3.2 Define a `--matrix-glow` CSS variable that resolves to `0 0 8px hsl(var(--accent-primary) / 0.3)` and apply it to focus-ring / primary-button / rail-hover utility classes via `box-shadow` (or equivalent existing utility) inside the matrix block.
- [x] 3.3 Wrap the glow application in `@media (prefers-reduced-motion: no-preference)` so reduced-motion users do not receive it.

## 4. Server allow-list

- [x] 4.1 Add `'matrix'` to `THEME_ID_ALLOWLIST` in `server/hub-router.ts` so `PATCH /api/hub/theme` accepts the new value and rejects everything else.

## 5. Settings preview card

- [x] 5.1 Confirm `client/src/features/settings/components/AppearanceSection.tsx` iterates over `Object.values(THEMES)` (or `THEME_IDS`) so the new theme appears automatically; if it has a hard-coded count or list, lift it to read from the registry.
- [x] 5.2 Confirm the rendered Appearance section shows four cards (one per built-in theme), each with the matrix tagline and swatches matching the registry entry.

## 6. Tests

- [x] 6.1 Extend `client/src/features/settings/lib/__tests__/themes.test.ts` to assert (a) `'matrix'` is in `THEME_IDS`; (b) the matrix Recharts series palette has 5 unique entries; (c) the matrix xterm palette has the required 19 keys (no missing entries vs the `XtermTheme` interface).
- [x] 6.2 Add an `AppearanceSection.test.tsx` (or extend the existing one) to assert that exactly four theme cards render and the matrix card is selectable.
- [x] 6.3 Add a server-side test (or extend `server/hub-router.test.ts`) to assert `PATCH /api/hub/theme` with body `{ "theme": "matrix" }` returns 200 and the persisted value updates, and that `PATCH` with `{ "theme": "matricks" }` returns 400.
- [x] 6.4 Add a contrast smoke test for the matrix theme: parse the resolved foreground / background HSL values and assert ≥ 4.5:1 contrast (use a tiny WCAG ratio helper if not already present).

## 7. Verification

- [x] 7.1 Run `npm run typecheck` and `npm test` from the repo root; all gates green (server 80% / client 80% / global 70% thresholds preserved).
- [x] 7.2 Manual verification: start `npm run dev`, switch to the Matrix theme in Settings, and verify (a) dashboard cards render with the new palette; (b) the splitter, sort chips, status filter, priority pills, draft pills, and épica badges are individually distinguishable; (c) an open xterm session reflows to the matrix palette without losing scrollback; (d) Analytics charts render legibly in matrix colors; (e) focus rings on primary buttons show the glow on a system without reduced-motion preference and do not show it with it on. _Validated live during this change — palette readable, refresh persistence fixed, matrix-rain decoration confirmed visible on hover._
- [x] 7.3 Run the regression guard from the spec: `grep -rn "'matrix'\|\"matrix\"" client/src --include="*.tsx" --include="*.ts"` must match only the theme registry, palette helpers, the Appearance card, and tests — never component code that branches on theme id.
