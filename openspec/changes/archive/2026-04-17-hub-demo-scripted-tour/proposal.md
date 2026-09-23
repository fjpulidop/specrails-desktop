## Why

The current hub-demo build renders the real specrails-hub UI in an iframe with static seeded fixtures. When the specrails-web landing page embeds it, the frame looks frozen — no motion, no narrative, no product story. We want the landing page to show what specrails-hub actually does at a glance. The cheapest way to get a premium "live product" feel — without recording a video or duplicating the UI in a different repo — is to have the demo build drive itself: a scripted tour that clicks through a canonical "Propose a spec → run it on Rail 1 → read the log" user journey on an infinite loop.

## What Changes

- Add a new `tour` module to the hub-demo build that orchestrates a canonical user journey as a beat-by-beat timeline.
- Render a synthetic on-screen cursor (absolute-positioned SVG) that glides between real DOM elements and performs clicks / keystrokes programmatically.
- Thread a "programmatic mode" flag through a small number of existing components (ProposeSpecModal, RailRow / RailControls, LogViewer) so the tour can drive them deterministically without hitting demo-mocked APIs.
- Seed the demo fixtures with the exact log lines and spec title used in the tour so the on-screen content matches the narrated beats.
- Respect `prefers-reduced-motion`: the tour renders its first beat statically and does not animate.
- The tour loops forever (no pause, no hover-handler) in v1; voicebox.sh demonstrates this pattern is enough for hero embedding.
- The tour is scoped to the demo build only. The real desktop/web hub client is untouched at runtime.

## Capabilities

### New Capabilities
- `hub-demo-scripted-tour`: an auto-playing, on-rails product demo inside the hub-demo build that shows the Propose Spec → Run Rail → View Log journey and is safe to embed in a cross-origin iframe.

### Modified Capabilities
_None. No existing spec describes the hub-demo build behaviour today._

## Impact

- **Code (new)**: `client/src/demo-mode/tour/` — timeline, orchestrator, fake cursor, log-stream driver.
- **Code (modified)**: `client/src/features/specs/components/ProposeSpecModal.tsx`, `RailRow.tsx` / `RailControls.tsx`, `LogViewer.tsx` gain an opt-in `programmaticMode` path that the tour uses in demo builds. Production builds are unchanged.
- **Fixtures**: `client/src/demo-mode/fixtures/` extended with the canonical spec title + log lines used by the tour (single source of truth).
- **Build**: no new npm dependency; orchestrator is pure React + CSS transforms.
- **Bundle impact**: the tour code lives behind a compile-time guard (`import.meta.env.MODE === 'demo'` or similar) so the production client bundle is not bloated.
- **Breaking**: none.
- **Downstream**: once dist-demo/ is rebuilt and copied into specrails-web/public/hub-demo/, the existing iframe auto-displays the tour. No web-side change is required for the tour to appear.
