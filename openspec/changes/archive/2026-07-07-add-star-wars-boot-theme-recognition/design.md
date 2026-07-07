# Design - add-star-wars-boot-theme-recognition

## Context
Specrails Desktop now has `star-wars` in `THEME_IDS`, the `THEMES` map, CSS theme tokens, `ThemeEffectLayer`, and the server-side allow-list. The remaining mismatch is the synchronous anti-FOUC boot surface in `client/index.html`, which runs before React and cannot import `client/src/lib/themes.ts`; it therefore keeps a small literal allow-list and splash palette table that must be updated whenever a built-in theme is added. The fix should preserve the existing boot sequence and only extend its static data for `star-wars`.

Scope: frontend

## Goal
Make a cached `star-wars` theme paint correctly from the first pre-React frame, including the inline splash screen.

## Non-Goals
- Do not modify the Star Wars palette, CSS token block, decorative trail component, or theme-effects registry.
- Do not change server-side theme persistence or validation behavior.
- Do not refactor the anti-FOUC script into a generated build artifact in this ticket.
- Do not change the existing default/fallback behavior except where needed to accept `star-wars`.

## Design

### Architecture
The boot path is a static HTML concern. `client/index.html` first migrates legacy localStorage keys, then reads `specrails-desktop:ui-theme`, checks it against a hardcoded allow-list, and sets `document.documentElement.dataset.theme` before the Vite bundle loads. The inline splash CSS then resolves theme-specific `--splash-*` variables from `html[data-theme="..."]` selectors.

The developer should extend those two static tables in place. Tests should treat `client/index.html` as a contract-bearing artifact by reading it from disk and asserting that the Star Wars id and splash values exist, because the code runs before React and is not importable as a module.

### Data shapes
```js
// client/index.html anti-FOUC script
var allowed = ['dracula', 'aurora-light', 'obsidian-dark', 'matrix', 'specrails', 'star-wars']
```

```css
/* client/index.html inline splash style */
html[data-theme="star-wars"] {
  --splash-bg: hsl(220 20% 4%);
  --splash-fg: hsl(210 30% 94%);
  --splash-primary: hsl(212 100% 62%);
  --splash-secondary: hsl(210 12% 65%);
  --splash-muted: hsl(215 15% 60%);
}
```

### State & lifecycle
On page load, before React mounts, the script reads `localStorage['specrails-desktop:ui-theme']`. If the value is `star-wars`, the updated allow-list permits it and sets `document.documentElement.dataset.theme = 'star-wars'`; the splash CSS immediately uses the Star Wars variables for the loading screen. React later hydrates and continues using the same theme through `ThemeContext`.

### Public API / surface
There is no external API change. The observable surface is the first painted HTML document state:

```text
localStorage['specrails-desktop:ui-theme'] = 'star-wars'
=> document.documentElement.dataset.theme === 'star-wars' before React loads
=> splash variables resolve from html[data-theme="star-wars"]
```

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Update the literal allow-list and splash block in `client/index.html` | Minimal, matches existing boot architecture, preserves pre-React synchronous paint | Keeps a duplicated theme list that can drift again | Yes |
| Generate the allow-list and splash CSS from `themes.ts` at build time | Removes duplication long term | Larger build refactor for a small boot fix; risks delaying the urgent regression | No |
| Move anti-FOUC logic into React/TypeScript | Single source of truth becomes easier | Too late for first paint; reintroduces wrong-theme flash | No |

The literal update is chosen because the boot script must stay synchronous and this ticket is scoped to a targeted recognition fix.

## Risks
- The boot allow-list can drift again; mitigate with a regression test that reads `client/index.html` and checks the allowed ids include `star-wars`.
- Splash colors can drift from `STAR_WARS_PALETTE`; mitigate with a regression test that asserts the Star Wars splash block contains the current palette values.
- `client/index.html` is not compiled by TypeScript; mitigate by running the client test suite and production build.

## Open questions
