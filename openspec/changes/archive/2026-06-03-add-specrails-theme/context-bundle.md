# Context Bundle — add-specrails-theme

> Quick-reference for the developer implementing this change. Read `design.md` for full reasoning.

## What this change is

Add a fifth hub theme named 'specrails' using the brand palette from `design_handoff_specrails_web/`. Make it the new `DEFAULT_THEME`. Three files, purely additive.

## Files touched

| File | Line range (approx.) | What changes |
|------|-----------------------|--------------|
| `client/src/features/settings/lib/themes.ts` | 15, 28, after line 328 | THEME_IDS + DEFAULT_THEME + palette const + descriptor + THEMES map |
| `client/src/globals.css` | after line ~208 | Insert new `[data-theme="specrails"]` block |
| `server/hub-router.ts` | line ~30 | Add `'specrails'` to THEME_ID_ALLOWLIST Set |

## Token reference

All 13 semantic tokens specified by the feature:

```
--background:       hsl(240 35% 4%)
--card:             hsl(238 30% 9%)
--background-deep:  hsl(240 38% 2%)
--foreground:       hsl(240 20% 94%)
--muted-foreground: hsl(240 12% 58%)
--border:           hsl(240 20% 100% / 0.08)
--accent-primary:   hsl(187 100% 41%)   ← cyan, also maps to --primary and --ring
--accent-secondary: hsl(280 38% 57%)    ← violet
--accent-success:   hsl(152 80% 44%)    ← emerald
--accent-info:      hsl(191 97% 50%)    ← electric cyan
--accent-warning:   hsl(42 90% 56%)     ← amber
--accent-highlight: hsl(248 70% 63%)    ← indigo
--accent-destructive: hsl(12 78% 52%)   ← tomato-red, also maps to --destructive
```

Derived tokens (see design.md D1 for derivation rationale):
```
--secondary / --muted / --accent / --input: hsl(238 26% 13%)  ← elevated surface
--primary-foreground / --destructive-foreground: hsl(240 35% 4%)  ← dark on bright
--glass-card-opacity: 28%
```

## Theme extension protocol (OCP checklist)

When adding any theme, ALL four steps are required:

- [ ] `THEME_IDS` array in `themes.ts` — add the id string
- [ ] `ThemeDescriptor` const in `themes.ts` — palette + xterm + chart + status + previewSwatches
- [ ] `THEMES` map in `themes.ts` — register the descriptor
- [ ] `[data-theme="<id>"]` block in `globals.css` — all `--color-*` + `--glass-card-opacity`
- [ ] `THEME_ID_ALLOWLIST` Set in `server/hub-router.ts` — allow PATCH endpoint

## Pattern to follow

The closest structural analogue is `[data-theme="obsidian-dark"]` (also a dark theme, similar lightness profile). Use it as the template for the CSS block ordering and the xterm bright-variant derivation rule (+10–15 lightness points on each bright color).

## Regression guard

CI runs: `grep -r 'dracula-' client/src/` must return 0 matches. The new palette const uses generic key names (`bg`, `card`, `fg`, `primary`, etc.) — not `dracula-*` — so this passes cleanly.

## Verify locally

```bash
# TypeScript
cd client && npx tsc --noEmit

# CSS build
cd client && npm run build

# Server typecheck + tests
npm run typecheck
npm test

# Manual: open the app, go to Settings > Appearance, select "SpecRails"
# Should show deep navy background with cyan accents
```

## What NOT to change

- `client/index.html` — the anti-FOUC script needs no changes; it reads localStorage and applies data-theme generically.
- Any component file — the theme system is OCP-designed; components use semantic tokens only.
- Any existing `[data-theme="..."]` block — purely additive.
- Coverage thresholds — this change adds no new logic paths requiring coverage.
