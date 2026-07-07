# Design - add-star-wars-theme-with-lightsaber-cursor-trail-and-blade-glow-accents

## Context
The repository is a React 19 + Vite + TypeScript client inside a Tauri desktop app. Previous work for ticket #3 has already added the `star-wars` theme id, palette, CSS token block, `LightsaberTrail`, and `ThemeEffectLayer` registration. The remaining Round 4 work is frontend-only: the global fixed `LightsaberTrail` sits behind app content at `z-index: -1`, while Mission Control currently paints an opaque `bg-background` root; Starfield must be view-scoped rather than added to the global theme dispatcher.

Scope: frontend

## Goal
Under the Star Wars theme, users see both the lightsaber cursor trail and a calm drifting starfield behind Mission Control and the Specs Board, while other themes and other views remain unchanged.

## Non-Goals
- Do not change the Star Wars palette, theme registry, server validator, boot script, or splash variables.
- Do not modify `LightsaberTrail.tsx` behavior or `ThemeEffectLayer.tsx` dispatch.
- Do not add Starfield to non-board/non-Mission-Control views.
- Do not show animated effects when the user requests reduced motion.

## Design

### Architecture
Keep the existing global effect model unchanged: `ThemeEffectLayer` continues to mount only one theme-wide effect, and `star-wars` continues to map to `LightsaberTrail`. Add a separate `Starfield` component under `client/src/components/theme-effects/` for view-local ambient background use.

Mount `Starfield` in `AgentModeSurface.tsx` and `DashboardPage.tsx`, each gated by `useActiveTheme().id === 'star-wars'`. Each target view root should establish a local stacking context (`relative`, `z-0` or equivalent) and render the Starfield as an absolutely positioned `pointer-events-none` layer behind the view's content (`absolute inset-0`, negative or lower z-index inside the local stacking context). The page content should remain above it via existing or explicit `relative z-10` wrappers.

Use `globals.css` for Star Wars-only transparency plumbing. Mirror the bounded Matrix selectors that collapse translucent utility backgrounds (`bg-card/N`, `from-card/*`, `to-card/*`, low-alpha status tints) so data panels remain legible, and add a narrow selector for the Mission Control outer root rather than globally making every `.bg-background` transparent. A dedicated data attribute on the Agent Mode root is preferred over a broad utility override.

### Data shapes
No persisted data shape changes.

`Starfield` internal star sample:

```ts
interface Star {
  x: number
  y: number
  radius: number
  alpha: number
  drift: number
}
```

### State & lifecycle
`Starfield` follows the canvas-effect lifecycle used by `MatrixRain` and `LightsaberTrail`:

- On mount, return immediately when `window.matchMedia('(prefers-reduced-motion: reduce)').matches`.
- Size the canvas using `devicePixelRatio` and rebuild stars on resize.
- Start a `requestAnimationFrame` loop only while `document.hidden === false`.
- On `visibilitychange`, cancel the RAF while hidden and resume with a reset timestamp when visible.
- On unmount, cancel RAF and remove listeners.

The animation should move points slowly and constantly, wrapping stars around the canvas edge. It should be ambient, low opacity, and non-interactive.

### Public API / surface
New component export:

```ts
export function Starfield(): JSX.Element
```

View-level usage:

```tsx
const isStarWars = useActiveTheme().id === 'star-wars'
{isStarWars && <Starfield />}
```

Mission Control root should expose a narrow styling hook:

```tsx
<div data-agent-mode-surface className="relative ... bg-background">
```

CSS hook:

```css
[data-theme="star-wars"] [data-agent-mode-surface] {
  background-color: transparent;
}
```

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Add Starfield to `ThemeEffectLayer` globally | Simple registration, follows theme effect precedent | Violates the ticket's view-scoped requirement and would show stars on every route | No |
| Mount Starfield locally in Mission Control and Dashboard | Matches the requested scope, avoids route awareness in the global dispatcher | Requires two small view edits and local stacking care | Yes |
| Globally override `[data-theme="star-wars"] .bg-background` | Fast way to reveal the trail | Too broad; can make nested panels and side panes illegible | No |
| Add a dedicated data attribute for the Mission Control outer canvas | Keeps transparency limited to the problematic root | One extra markup hook | Yes |

The chosen approach preserves the existing theme-effect Open/Closed Principle: global theme dispatch remains theme-only, while view-only ambience is mounted by the views that own it.

## Risks
- Stacking contexts can hide the fixed `LightsaberTrail` or local `Starfield`; mitigate by keeping `#root` as the root stacking context, using `pointer-events: none`, and ensuring target view content sits above the local starfield layer.
- Starfield animation can become visually noisy; mitigate with small stars, low alpha, slow drift, and no flashes.
- CSS transparency can reduce readability; mitigate by mirroring the Matrix opaque-collapse selectors and narrowly targeting only the Agent Mode outer root for transparency.
- Tests may be brittle if they rely on canvas pixels in jsdom; mitigate by testing lifecycle calls, mounted class/style hooks, theme gates, and CSS selector presence.

## Open questions
- None.
