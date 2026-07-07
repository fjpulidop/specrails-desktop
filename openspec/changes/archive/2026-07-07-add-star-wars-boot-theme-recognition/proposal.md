# Add Star Wars theme with lightsaber cursor trail and blade-glow accents

## Why
The Star Wars theme is already present in the theme registry, CSS tokens, effect layer, and server validator, but the pre-React anti-FOUC script in `client/index.html` still has its own stale theme allow-list. A returning user with `star-wars` cached can therefore see the boot script discard that value and paint the wrong theme before React mounts.

## What changes
- Add `star-wars` to the anti-FOUC boot script allow-list in `client/index.html`.
- Add a matching `html[data-theme="star-wars"]` splash-screen variable block using the current Star Wars palette values.
- Add regression coverage that keeps the boot allow-list and splash block synchronized with the registered Star Wars theme.

## Impact
- Affected specs: `desktop-theme-system`
- Affected code: The intended production change is scoped to `client/index.html`, with regression coverage in the existing client theme tests that read the static HTML boot surface.
- Out of scope: Jedi/Sith variants, sound effects, animated intro/opening crawl, cursor icon redesign, localized theme docs, palette changes, `LightsaberTrail` changes, `ThemeEffectLayer` changes, `THEME_IDS` changes, `globals.css` changes, and server theme-validator changes.
