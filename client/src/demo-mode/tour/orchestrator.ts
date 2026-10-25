/**
 * Async beat runner. Iterates the canonical timeline, mutates tourStore, and
 * loops forever unless prefers-reduced-motion is set.
 *
 * openspec: desktop-demo-scripted-tour (design.md §Decision 8)
 */

import { tourStore } from './tour-store'
import { findTourElement, type TourSelectorKey } from './selectors'
import { TOUR_TIMELINE, type Beat } from './timeline'
import { TOUR_LOG_LINES, TOUR_LOG_LINE_INTERVAL_MS } from '../fixtures/tour-log'
import { prefersReducedMotion } from '../../lib/a11y-prefs'

/** Stable sonner toast id — one per page, so loops replace instead of stack. */
const TOUR_TOAST_ID = 'tour-spec-generation'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Wait through a single beat, honouring pause.
async function wait(durationMs: number) {
  const start = Date.now()
  let remaining = durationMs
  while (remaining > 0) {
    if (tourStore.getState().paused) {
      await sleep(100)
      continue
    }
    const chunk = Math.min(remaining, 100)
    await sleep(chunk)
    remaining = durationMs - (Date.now() - start)
  }
}

function targetCoords(key: TourSelectorKey): { x: number; y: number } | null {
  const el = findTourElement(key)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  // Offset the cursor tip so it sits just inside the element's top-left quadrant.
  return { x: rect.left + rect.width * 0.35, y: rect.top + rect.height * 0.55 }
}

async function runBeat(beat: Beat) {
  tourStore.update({ currentBeatId: beat.id })

  switch (beat.kind) {
    case 'idle':
      await wait(beat.duration)
      return

    case 'moveTo': {
      const coords = targetCoords(beat.target) ?? fallbackCoord(beat.target)
      tourStore.update({ cursorX: coords.x, cursorY: coords.y })
      await wait(beat.duration)
      return
    }

    case 'click': {
      const coords = targetCoords(beat.target) ?? fallbackCoord(beat.target)
      tourStore.update({
        cursorX: coords.x,
        cursorY: coords.y,
        clickPulse: tourStore.getState().clickPulse + 1,
      })
      await wait(beat.duration)
      return
    }

    case 'type': {
      const fullText = beat.text
      const steps = Math.max(6, Math.floor(fullText.length / 2))
      const stepMs = Math.max(40, Math.floor(beat.duration / steps))
      tourStore.update({ typedText: '' })
      for (let i = 1; i <= steps; i++) {
        if (tourStore.getState().paused) {
          await sleep(100)
          i--
          continue
        }
        const cut = Math.ceil((fullText.length * i) / steps)
        tourStore.update({ typedText: fullText.slice(0, cut) })
        await sleep(stepMs)
      }
      tourStore.update({ typedText: fullText })
      return
    }

    case 'wait':
      await wait(beat.duration)
      return

    case 'action': {
      await runAction(beat.name, beat.duration)
      return
    }

    case 'fadeReset':
      // No more fade-to-black — just clear visual state in place so the
      // dashboard re-appears and the next loop starts on top of it.
      tourStore.softReset()
      document.body.classList.remove('tour-new-spec-visible')
      await wait(beat.duration)
      return
  }
}

async function runAction(name: string, durationMs: number) {
  switch (name) {
    case 'openProposeSpecModal':
      tourStore.update({ modalOpen: true, typedText: '' })
      await wait(durationMs)
      return

    case 'closeProposeSpecModal':
      tourStore.update({ modalOpen: false })
      await wait(durationMs)
      return

    case 'showToast':
      // Use the real sonner toast system so it looks identical to a real user
      // action. Stable id so each loop iteration REPLACES the previous toast
      // instead of stacking.
      try {
        const sonner = await import('sonner')
        sonner.toast.loading('specrails-desktop · Add JWT auth with refresh…', {
          id: TOUR_TOAST_ID,
          description: 'Generating spec...',
          duration: 2800,
        })
      } catch {
        // no-op — toast is decorative
      }
      await wait(durationMs)
      return

    case 'spawnNewSpecCard':
      // Reveal the real "new spec" card (id 9999) inside the Specs column
      // so existing tickets shift DOWN to make room. NO overlay yet — the
      // viewer sees the real card slot open and the card appear there.
      document.body.classList.add('tour-new-spec-visible')
      // Transition toast from "loading" to "success" with the same stable
      // id so it doesn't pile up across loops. Auto-dismisses shortly after.
      try {
        const sonner = await import('sonner')
        sonner.toast.success('specrails-desktop · Spec created', {
          id: TOUR_TOAST_ID,
          description: 'Add JWT auth with refresh tokens',
          duration: 2200,
        })
      } catch {
        // no-op
      }
      await wait(durationMs)
      return

    case 'moveSpecToRail1': {
      // Step 1: pop the drag overlay in AT the real 9999 card position,
      // while the real card is still visible. Two paints later we flip to
      // the rail-bound stage — CSS transitions the top/left/width smoothly
      // to Rail 1. Using requestAnimationFrame ensures the first render
      // has the overlay at the Specs position before the transition starts.
      tourStore.update({ dragOverlayStage: 'at-specs' })
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })

      // Cursor should drag the card — compute rail 1 body center and move
      // cursor there in the same update, so the cursor transition (800 ms)
      // and the card transition (900 ms) play in parallel rather than the
      // cursor standing still while the card magically teleports.
      const railEl = document.querySelector('[data-tour="rail-1"]') as HTMLElement | null
      if (railEl) {
        const rect = railEl.getBoundingClientRect()
        tourStore.update({
          dragOverlayStage: 'at-rail',
          cursorX: rect.left + rect.width * 0.25,
          cursorY: rect.top + 54,
        })
      } else {
        tourStore.update({ dragOverlayStage: 'at-rail' })
      }
      // The real 9999 ticket disappears from Specs at the same moment (same
      // as a real drag-drop would). The CSS has `transition: max-height`
      // applied from the `.tour-new-spec-visible` class, which APPLIES to
      // the collapse too → the card smoothly shrinks and the existing
      // tickets glide up naturally into the freed space.
      document.body.classList.remove('tour-new-spec-visible')
      await wait(durationMs)
      return
    }

    case 'markRail1Running':
      tourStore.update({ rail1Running: true })
      await wait(durationMs)
      return

    case 'openRail1Log':
      tourStore.update({ logDrawerOpen: true, logLines: [] })
      await wait(durationMs)
      return

    case 'appendLogLine': {
      // Tail every TOUR_LOG_LINE_INTERVAL_MS until the canonical set is exhausted.
      const total = TOUR_LOG_LINES.length
      const end = Date.now() + durationMs
      while (Date.now() < end && tourStore.getState().logLines.length < total) {
        if (tourStore.getState().paused) {
          await sleep(100)
          continue
        }
        tourStore.appendLogLine()
        await sleep(TOUR_LOG_LINE_INTERVAL_MS)
      }
      return
    }

    case 'resetAll':
      tourStore.softReset()
      // Ensure the body class is cleared in case a loop aborted mid-beat
      // and left it on.
      document.body.classList.remove('tour-new-spec-visible')
      // Dismiss the previous loop's toast so it doesn't bleed into the next
      // loop's toast (which uses the same stable id, but dismiss is cheap
      // insurance against any lingering state).
      try {
        const sonner = await import('sonner')
        sonner.toast.dismiss(TOUR_TOAST_ID)
      } catch {
        // no-op
      }
      await wait(durationMs)
      return
  }
}

/** Best-effort coordinates when the target element is not in the DOM yet. */
function fallbackCoord(key: TourSelectorKey): { x: number; y: number } {
  // Rough anchors tuned for the default desktop-demo layout. Used only on the
  // first frames before the real DOM has rendered. Once the element exists,
  // `targetCoords` takes over.
  const w = window.innerWidth
  const h = window.innerHeight
  switch (key) {
    case 'addSpecButton':
      return { x: w * 0.14, y: h * 0.18 }
    case 'proposeSpecTextarea':
      return { x: w * 0.5, y: h * 0.4 }
    case 'generateSpecButton':
      return { x: w * 0.6, y: h * 0.55 }
    case 'rail1PlayButton':
      return { x: w * 0.52, y: h * 0.55 }
    case 'rail1LogButton':
      return { x: w * 0.48, y: h * 0.55 }
    default:
      return { x: w / 2, y: h / 2 }
  }
}

async function runLoop() {
  // Hold 1s between iterations for a calmer rhythm.
  const INTER_LOOP_HOLD_MS = 1000

  while (true) {
    for (const beat of TOUR_TIMELINE) {
      await runBeat(beat)
    }
    await wait(INTER_LOOP_HOLD_MS)
  }
}

interface TourHandle {
  pause: () => void
  resume: () => void
}

let started = false

export function startTour(): TourHandle | null {
  if (started) return globalHandle
  started = true

  // Honour reduced motion: render idle state only.
  const reducedMotion =
    typeof window !== 'undefined' && prefersReducedMotion()
  if (reducedMotion) {
    tourStore.update({ cursorVisible: false })
    return null
  }

  tourStore.update({
    cursorVisible: true,
    cursorX: window.innerWidth - 80,
    cursorY: window.innerHeight - 80,
  })

  // Fire-and-forget. The loop rejects only if the browser crashes.
  runLoop().catch((err) => {
    console.error('[tour] loop crashed', err)
  })

  globalHandle = {
    pause: () => tourStore.pause(),
    resume: () => tourStore.resume(),
  }

  // Expose a debug hook for screenshots and marketing captures (spec: debug
  // pause hook requirement).
  ;(window as unknown as Record<string, unknown>).__specrailsTour = globalHandle

  return globalHandle
}

let globalHandle: TourHandle = {
  pause: () => tourStore.pause(),
  resume: () => tourStore.resume(),
}
