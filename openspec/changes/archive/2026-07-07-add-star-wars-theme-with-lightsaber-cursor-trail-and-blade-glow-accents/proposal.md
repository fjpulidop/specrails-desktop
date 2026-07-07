# Add Star Wars theme with lightsaber cursor trail and blade-glow accents

## Why
The Star Wars theme, palette, boot recognition, and lightsaber trail already exist, but the cursor effect is still hidden behind opaque page backgrounds in Mission Control. The final ticket revision asks for the theme's ambient effects to read app-wide in the two primary work views without leaking into other themes or secondary pages.

## What changes
- Make Star Wars-specific translucent panel/background CSS match the Matrix precedent closely enough that the global `LightsaberTrail` can be seen behind Mission Control and the Specs Board.
- Add a `Starfield` canvas effect that drifts slowly behind only Mission Control and the Specs Board when the active theme is `star-wars`.
- Gate the local Starfield mounts through `useActiveTheme().id === 'star-wars'`, leaving `ThemeEffectLayer` as a theme-only dispatcher for global effects.
- Preserve reduced-motion and document-visibility behavior for the new canvas effect.

## Impact
- Affected specs: `desktop-theme-system`
- Affected code: Client-side React theme-effect components, the Mission Control surface, the Dashboard page, and scoped Star Wars CSS in `client/src/globals.css`; tests should be added beside the affected components.
- Out of scope: Palette revisions, theme id registration, server-side theme validation, anti-FOUC boot changes, sound effects, custom cursor icons, opening-crawl animation, localized theme documentation, and changes to `LightsaberTrail` or `ThemeEffectLayer` dispatch logic.
