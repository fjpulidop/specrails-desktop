# Add Star Wars theme with lightsaber cursor trail and blade-glow accents

## Why
The first Star Wars theme implementation shipped the requested theme and effects, but its palette still reads too close to the existing SpecRails theme. The remaining review request is a palette-only re-differentiation: the Star Wars background should read as neutral near-black rather than navy, the secondary accent should be steel-gray/silver rather than violet, and the Jedi blue should be a purer blue that is clearly separated from SpecRails cyan.

## What changes
- Revise `STAR_WARS_PALETTE` in `client/src/lib/themes.ts` so background/elevation colors are desaturated neutral deep-space black, primary/info are a saturated 212-215 degree Jedi blue, and secondary is a low-saturation steel-gray/silver accent.
- Update the Star Wars xterm palette, 5-color chart palette, and status colors to reflect the revised background, secondary, and primary while preserving existing red, green, gold, and orange accents.
- Update the matching `[data-theme="star-wars"]` block in `client/src/globals.css` so every Star Wars token stays synchronized with the JS palette, including `--starwars-glow`.
- Add focused tests that fail against the current palette collisions and pass only when Star Wars no longer overlaps with the SpecRails navy/violet/cyan hues.

## Impact
- Affected specs: `desktop-theme-system`
- Affected code: This follow-up is limited to Star Wars theme color literals in `client/src/lib/themes.ts`, the matching Star Wars CSS token block in `client/src/globals.css`, and palette-focused tests. No component, theme-effect, registry, server allow-list, locale, or other theme changes are part of this revision.
- Out of scope: Changes to `LightsaberTrail.tsx`, `ThemeEffectLayer.tsx`, `THEME_IDS`, server theme validation, docs localization, sound effects, animated intro/opening crawl, custom cursor icons, or any user-facing Jedi/Sith variant toggle.
