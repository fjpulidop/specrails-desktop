import { motion, AnimatePresence, useReducedMotion } from 'motion/react'

// The builder-mode halo (reskin-project-builder-into-agent-panel D3): an
// animated ring of light orbiting the agent identity while the Builder skin is
// active. The orbit itself is CSS-keyframe driven (no per-frame JS — see the
// `builder-halo-spin` keyframes in globals.css); `motion` only handles
// enter/exit. Under
// `prefers-reduced-motion` the ring renders as a static glow, no rotation.

interface BuilderHaloProps {
  active: boolean
  /** Ring inset relative to the wrapped element, in px (negative = outside). */
  inset?: number
  /** Border radius of the ring — '9999px' for circular identities (bubble,
   *  header icon), the card radius (e.g. '1rem') for the composer box. */
  radius?: string
  className?: string
  /** Enter / exit fade durations in ms (the Builder's entry flourish keeps
   *  the 350 ms defaults; the agent's thinking halo fades out slower). */
  fadeInMs?: number
  fadeOutMs?: number
}

export function BuilderHalo({ active, inset = -4, radius = '9999px', className, fadeInMs = 350, fadeOutMs = 350 }: BuilderHaloProps) {
  const reducedMotion = useReducedMotion()

  return (
    <AnimatePresence>
      {active && (
        <motion.span
          aria-hidden
          data-testid="builder-halo"
          data-reduced-motion={reducedMotion ? 'true' : undefined}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1, transition: { duration: fadeInMs / 1000, ease: 'easeOut' } }}
          exit={{ opacity: 0, scale: 1.15, transition: { duration: fadeOutMs / 1000, ease: 'easeInOut' } }}
          style={{ inset }}
          className={`pointer-events-none absolute ${className ?? ''}`}
        >
          {/* The orbiting ring: a spinning conic gradient clipped to a thin
              border band by an XOR/exclude mask on this layer (content-box vs
              full box), so the ring follows ANY radius — circle or card.
              Static (no spin) when the user prefers reduced motion. */}
          <span
            className="absolute inset-0 overflow-hidden"
            style={{
              borderRadius: radius,
              padding: '2px',
              WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              WebkitMaskComposite: 'xor',
              maskComposite: 'exclude',
            }}
          >
            <span
              className={`absolute left-1/2 top-1/2 aspect-square w-[250%] -translate-x-1/2 -translate-y-1/2 ${reducedMotion ? '' : 'animate-[builder-halo-spin_2.6s_linear_infinite]'}`}
              style={{
                background:
                  'conic-gradient(from 0deg, transparent 0%, color-mix(in srgb, var(--color-accent-primary) 90%, transparent) 18%, color-mix(in srgb, var(--color-accent-highlight) 85%, transparent) 32%, transparent 55%)',
              }}
            />
          </span>
          {/* Soft ambient glow under the ring so the transformation reads even
              at a glance / in reduced motion. */}
          <span
            className="absolute inset-0 opacity-60"
            style={{
              borderRadius: radius,
              boxShadow:
                '0 0 12px 2px color-mix(in srgb, var(--color-accent-primary) 45%, transparent), inset 0 0 8px 1px color-mix(in srgb, var(--color-accent-highlight) 30%, transparent)',
            }}
          />
        </motion.span>
      )}
    </AnimatePresence>
  )
}
