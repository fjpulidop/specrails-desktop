import { useEffect, useRef, useState } from 'react'

/**
 * Smooths bursty `chat_stream` deltas into a steady character-by-character
 * render driven by `requestAnimationFrame`. Returns the visible substring of
 * `target` that has been "typed in" so far. When the streaming turn ends
 * (or the backlog exceeds the safety threshold), the remainder flushes in
 * one frame so no characters are ever dropped.
 *
 * The rate is computed each frame so a 1 KB delta empties in ~250 ms rather
 * than dripping for 16 s at 1 char/frame.
 *
 * See accelerate-spec-chat-first-token design.md D8.
 */

const SAFETY_FLUSH_BYTES = 4096
const TARGET_DRAIN_MS = 250
// Steady base pace (~18 chars/frame @60fps) — smooth "typing" that never chunks.
const BASE_CHARS_PER_SEC = 1100
// Gentle proportional catch-up when behind, capped so a burst reveals smoothly.
const CATCHUP_FRACTION = 0.1
const MAX_CATCHUP_CHARS = 40

export function useSmoothStream(target: string, isStreaming: boolean): string {
  // Initialise to the CURRENT target (not '') so a component that mounts into an
  // already-in-progress stream — e.g. restoring a minimized agent chat mid-turn —
  // starts caught-up instead of re-typing the whole accumulated output. For a
  // fresh turn the target is empty, so first-token behaviour is unchanged.
  const [displayed, setDisplayed] = useState(target)
  const displayedRef = useRef(target)
  const targetRef = useRef(target)
  const lastTickRef = useRef<number>(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => { targetRef.current = target }, [target])
  useEffect(() => { displayedRef.current = displayed }, [displayed])

  useEffect(() => {
    if (!isStreaming && target.length <= displayedRef.current.length) {
      // Idle and nothing pending — make sure we don't have a stale RAF.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Ensure displayed catches up exactly to target on settle.
      if (displayed !== target) setDisplayed(target)
      return
    }

    const tick = (now: number) => {
      const cur = displayedRef.current
      const tgt = targetRef.current
      const backlog = tgt.length - cur.length

      if (backlog <= 0) {
        rafRef.current = null
        return
      }

      // Safety flush: if we fall too far behind, drop the smoothing.
      if (backlog > SAFETY_FLUSH_BYTES) {
        setDisplayed(tgt)
        displayedRef.current = tgt
        rafRef.current = null
        return
      }

      const last = lastTickRef.current || now
      // Clamp dt so a paused/backgrounded tab (huge dt) doesn't reveal a whole
      // chunk in one frame when it resumes.
      const dtMs = Math.min(48, Math.max(0, now - last))
      lastTickRef.current = now
      // Luxurious, steady cadence: a constant base reading pace plus a gently
      // capped proportional catch-up, so a large burst never dumps in one frame
      // (that "chunking" is what reads as a glitch). Drain-in-window is kept as a
      // floor so tiny deltas still finish promptly.
      const base = (BASE_CHARS_PER_SEC * dtMs) / 1000
      const catchUp = Math.min(backlog * CATCHUP_FRACTION, MAX_CATCHUP_CHARS)
      const drainFloor = (backlog / TARGET_DRAIN_MS) * dtMs
      const advance = Math.max(1, Math.min(Math.round(Math.max(base + catchUp, drainFloor)), backlog))
      const next = tgt.slice(0, Math.min(tgt.length, cur.length + advance))
      setDisplayed(next)
      displayedRef.current = next

      rafRef.current = requestAnimationFrame(tick)
    }

    if (rafRef.current == null) {
      lastTickRef.current = 0
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [target, isStreaming, displayed])

  return displayed
}
