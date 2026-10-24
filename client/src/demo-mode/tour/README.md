# desktop-demo scripted tour

openspec: `desktop-demo-scripted-tour`

Auto-playing visual tour that runs inside the static `desktop-demo` build (loaded
by `demo-entry.tsx`, output to `dist-demo/`). Not compiled into the production
client bundle.

## Architecture

The tour is an **overlay** on top of the real demo app. It does NOT drive
production components with programmatic clicks; instead it renders its own
lightweight fake visuals (modal, spec card, rail chrome, log drawer) over the
live dashboard and glides a synthetic cursor between them.

This keeps the tour self-contained and zero-risk for the real app client at
the cost of a small visual-state drift as the real UI evolves.

```
demo-entry.tsx
  └─▶ mount <TourOverlay/> and <TourCursor/> alongside <App/>
  └─▶ startTour() via requestIdleCallback

tour/
  ├─ timeline.ts    — 15-beat canonical timeline
  ├─ selectors.ts   — DOM selectors for cursor targets (data-tour="…")
  ├─ tour-store.ts  — external store (useSyncExternalStore)
  ├─ orchestrator.ts — async beat runner + infinite loop
  ├─ TourCursor.tsx  — absolute-positioned SVG cursor
  ├─ TourOverlay.tsx — fake modal / spec card / rail / log drawer
  └─ tour.css        — keyframes (tour-click-ring, tour-fade-in, …)
```

## Beats

```
01 idle                  → cursor parked bottom-right
02 moveTo  addSpecButton → cursor glides to real "+" button
03 click                 → cursor pulse
04 moveTo  textarea      → cursor inside fake modal
05 type    description   → typewriter effect
06 moveTo+click submit   → cursor + click pulse on fake button
07 action  closeModal + showToast
08 action  spawnNewSpecCard     → fake card fades in
09 action  moveSpecToRail1      → card slides to Rail 1
10 moveTo+click rail-1-play
11 action  markRail1Running
12 moveTo+click rail-1-logs
13 action  openRail1Log         → fake drawer slides in
14 action  appendLogLine × 11   → canonical lines tail in
15 fadeReset + resetAll
```

Total ≈ 18 s. Loops forever. `prefers-reduced-motion: reduce` skips
`startTour()` entirely.

## Debug hook

`window.__specrailsTour.pause()` / `.resume()` for screenshots.

## Selectors

Selectors live in `selectors.ts`. Every cursor target uses `data-tour="…"`.
Real DOM: `SpecsBoard` New spec button (`data-tour="add-spec-btn"`). Everything else
targets elements inside `TourOverlay` fakes.
