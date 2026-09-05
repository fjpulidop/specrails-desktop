import { BuilderHalo } from '../project-builder/BuilderHalo'
import { useEffectsPrefs } from '../../lib/effects-prefs'

// The Builder's orbiting halo, borrowed for the agent composer CARD (the
// outer glass card — selectors, box and git bar — not the inner textarea)
// while a turn is thinking / writing: fades in when the turn starts, fades
// out (slower) when the reply settles. Gated by Settings ▸ Effects; the ring
// itself already honours prefers-reduced-motion (static glow, no spin).

interface AgentThinkingHaloProps {
  /** A turn is in flight (thinking or streaming). */
  active: boolean
  radius?: string
  inset?: number
}

export function AgentThinkingHalo({ active, radius = '0.75rem', inset = -3 }: AgentThinkingHaloProps) {
  const { agentThinkingHalo } = useEffectsPrefs()
  if (!agentThinkingHalo) return null
  return (
    <span data-testid="agent-thinking-halo" data-active={active} className="contents">
      <BuilderHalo active={active} radius={radius} inset={inset} fadeInMs={450} fadeOutMs={800} />
    </span>
  )
}
