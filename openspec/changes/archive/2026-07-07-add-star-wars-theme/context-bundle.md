# Context Bundle — add-star-wars-theme

> Quick-reference for the developer implementing this change. Read `design.md` for full reasoning, `tasks.md` for the ordered checklist.

## What this change is

Add a sixth theme, `star-wars`, plus a new decorative cursor-trail effect (`LightsaberTrail`), following the exact registry pattern the `matrix` and `specrails` themes already use. Purely additive — no component code changes outside the theme registry, the CSS token file, and the new effect component.

## Files touched

| File | What changes |
|------|--------------|
| `client/src/lib/themes.ts` | `THEME_IDS` += `'star-wars'`; new `STAR_WARS_PALETTE` const + `STAR_WARS: ThemeDescriptor`; `THEMES` map += entry. `DEFAULT_THEME` stays `'specrails'` — unchanged. |
| `client/src/globals.css` | New `[data-theme="star-wars"]` token block (after `[data-theme="specrails"]`); `--starwars-glow` + focus-visible rule (parallel to `--matrix-glow`); new border-glow rule for `a[aria-current="page"]` and `.border-accent-primary` scoped to `[data-theme="star-wars"]`. |
| `client/src/components/theme-effects/LightsaberTrail.tsx` | **New file.** Canvas cursor-trail effect, mirrors `MatrixRain.tsx`'s contract. |
| `client/src/components/theme-effects/ThemeEffectLayer.tsx` | `THEME_EFFECTS` += `'star-wars': LightsaberTrail`. |
| `server/desktop-router.ts` | `THEME_ID_ALLOWLIST` (line ~71) += `'star-wars'`. |
| `client/src/locales/{en,es,fr,de,pt,it,zh,ja}/settings.json` | `appearance.taglines` += `"star-wars"` key (all 8 locales, for locale-parity). |
| `client/src/lib/__tests__/themes.test.ts` | Update 3 hardcoded fixtures (`THEME_IDS` exact-array, dark-scheme list, `darks` distinctness list) to include `star-wars`; add a `star-wars`-specific describe block. |
| `client/src/components/theme-effects/__tests__/ThemeEffectLayer.test.tsx` | **New file.** Registry dispatch test (none exists today for this component). |
| `client/src/components/theme-effects/__tests__/LightsaberTrail.test.tsx` | **New file.** Smoke test (reduced-motion, visibility pause, pointer-events/z-index). |
| `server/desktop-router.test.ts` | Add a `PATCH /api/theme` case for `star-wars`. |

## Token reference (concrete values — see `design.md` Decision D1 for hue rationale)

```
--color-background:             hsl(224 45% 5%)     deep-space near-black, blue-tinted
--color-foreground:             hsl(210 30% 94%)    cool near-white
--color-card:                   hsl(224 38% 10%)
--color-popover:                hsl(224 45% 5%)
--color-primary / --color-ring: hsl(212 100% 62%)   Jedi blue  ← also --color-accent-primary AND --color-accent-info (same hue, per ticket)
--color-secondary (chrome bg):  hsl(224 30% 14%)
--color-muted:                  hsl(224 26% 11%)
--color-accent (hover bg):      hsl(224 30% 14%)
--color-destructive:            hsl(355 92% 56%)    Sith red
--color-destructive-foreground: hsl(210 30% 97%)    near-white (matches every other theme's convention)
--color-border:                 hsl(215 30% 55% / 0.16)
--color-input:                  hsl(224 28% 13%)

--color-accent-primary:   hsl(212 100% 62%)   Jedi blue
--color-accent-info:      hsl(212 100% 62%)   same hue as primary (ticket-directed — see design.md Risk)
--color-accent-success:   hsl(140 65% 50%)    Force green
--color-accent-secondary: hsl(280 65% 64%)    violet — Mace Windu homage
--color-accent-warning:   hsl(28 95% 56%)     blaster orange
--color-accent-highlight: hsl(45 90% 55%)     droid gold
--color-surface:          hsl(224 34% 12%)
--color-background-deep:  hsl(224 55% 3%)

--color-scrollbar-thumb:       hsl(215 25% 45% / 0.4)
--color-scrollbar-thumb-hover: hsl(212 60% 55% / 0.6)
--color-prose-table-stripe:    hsl(224 34% 12% / 0.5)
--color-prose-table-header:    hsl(224 34% 12% / 0.85)
--color-toast-shadow:          hsl(224 55% 2% / 0.65)
--glass-card-opacity:          32%

--starwars-glow: drop-shadow(0 0 10px hsl(212 100% 62% / 0.45))
```

`--color-primary-foreground` / `--color-card-foreground` / `--color-popover-foreground` / `--color-secondary-foreground` / `--color-muted-foreground` / `--color-accent-foreground` follow the same pattern every existing theme uses: dark-on-bright for `*-foreground` paired with a saturated accent (→ `--color-background`'s value), light-on-dark for text-bearing surfaces (→ `--color-foreground`'s value, or `muted`'s own dimmer variant `hsl(215 15% 60%)` for `--color-muted-foreground`).

## Theme extension protocol (OCP checklist — same 5 steps every prior theme followed)

- [ ] `THEME_IDS` array in `themes.ts` — add `'star-wars'`
- [ ] `STAR_WARS_PALETTE` const + `STAR_WARS: ThemeDescriptor` in `themes.ts` — palette + xterm + chart + status + previewSwatches
- [ ] `THEMES` map in `themes.ts` — register `'star-wars': STAR_WARS`
- [ ] `[data-theme="star-wars"]` block in `globals.css` — all `--color-*` + `--glass-card-opacity` + `--starwars-glow`
- [ ] `THEME_ID_ALLOWLIST` Set in `server/desktop-router.ts` — allow the PATCH endpoint value

Plus, unique to this theme (not part of the generic protocol — `matrix` is the only prior theme that also did this):

- [ ] New `LightsaberTrail.tsx` effect component + `THEME_EFFECTS` registration in `ThemeEffectLayer.tsx`
- [ ] Border-glow CSS rule for `a[aria-current="page"]` + `.border-accent-primary` (no prior theme did this — `matrix` only has the focus-visible glow, not a border-glow)

## Pattern to follow

- **Palette/CSS block shape**: closest structural analogue is `[data-theme="matrix"]` — also a dark theme with BOTH a `--<theme>-glow` custom property AND a registered `theme-effects/` component. Use its block ordering (base tokens → accent-* tokens → decorative tokens → glow custom property) as the template.
- **Effect component shape**: `MatrixRain.tsx` is the literal template for `LightsaberTrail.tsx`'s lifecycle (resize/pointermove/mouseleave/visibilitychange listeners, RAF loop, reduced-motion early-return in `useEffect`, the exact `<canvas aria-hidden className="fixed inset-0 pointer-events-none" style={{ zIndex: -1 }} />` return shape). Only the per-frame draw logic differs (stroked tapered polyline instead of per-glyph reveal-alpha field) — see `design.md` Decision D2.

## Regression guards to keep passing

- `grep -rn "dracula-" client/src --include="*.ts" --include="*.tsx" --include="*.css"` → must stay 0 matches (untouched by this change).
- The base spec's existing regression scenario (`openspec/specs/desktop-theme-system/spec.md`, "Component code does not branch on theme identifier"): `grep -rn "'star-wars'\|\"star-wars\"" client/src --include="*.tsx" --include="*.ts"` excluding `client/src/lib/themes.ts`, `client/src/lib/theme-palette.ts`, `client/src/components/pickers/ThemePickerGrid.tsx` (only via the generic `THEME_IDS` loop — no literal `'star-wars'` string should appear there), and `client/src/components/theme-effects/` → must return zero matches in component code outside those excluded files.

## Verify locally

```bash
# TypeScript
cd client && npx tsc --noEmit

# Client unit tests + coverage
cd client && npm run test:coverage

# Server typecheck + tests + coverage
npm run typecheck
npm run test:coverage

# Manual: open the app (npm run dev), go to Settings > Appearance, select "Star Wars"
# Should show a deep-space background, blue/red/gold/green/violet accents,
# a thin glowing cursor trail behind panels, and a blue focus/border glow
# on buttons/links/active nav/selected cards.
```

## What NOT to change

- `client/index.html` — the anti-FOUC boot script needs no changes; it reads `localStorage` and applies `data-theme` generically.
- `client/src/context/ThemeContext.tsx`, `client/src/lib/theme-palette.ts`, `client/src/components/pickers/ThemePickerGrid.tsx` — confirmed by reading all three: fully generic over `THEME_IDS`/`THEMES`, zero changes needed.
- `MatrixRain.tsx` — do not refactor it to share code with `LightsaberTrail.tsx` in this change (see `design.md` Decision D2 — a shared hook is a separate, larger refactor, out of scope here).
- Any existing `[data-theme="..."]` block — purely additive; the other five blocks must stay byte-identical.
- `docs/guide/*/settings/1-themes.md` — explicitly deferred as a fast-follow per the ticket's Out of Scope section.
- The `DEFAULT_THEME` constant (`'specrails'`) — this change does not reassign the default.
