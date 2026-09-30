import { BuilderHalo } from '../../builder/components/project-builder/BuilderHalo'
import { useEffectsPrefs } from '../../settings/lib/effects-prefs'

// The Builder's orbiting halo, borrowed for the agent composer CARD (the
// single flat input surface, including its bottom controls)
// while a turn is thinking / writing: fades in when the turn starts, fades
// out (slower) when the reply settles. Gated by Settings ▸ Effects; the ring
// itself already honours prefers-reduced-motion (static glow, no spin).

interface AgentThinkingHaloProps {
  /** A turn is in flight (thinking or streaming). */
  active: boolean
  radius?: string
  inset?: number
}

export function AgentThinkingHalo({ active, radius = '1.5rem', inset = -1 }: AgentThinkingHaloProps) {
  const { agentThinkingHalo } = useEffectsPrefs()
  if (!agentThinkingHalo) return null
  return (
    <span data-testid="agent-thinking-halo" data-active={active} className="contents">
      <BuilderHalo active={active} radius={radius} inset={inset} fadeInMs={450} fadeOutMs={800} />
    </span>
  )
}
