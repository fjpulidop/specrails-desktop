import { Check, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// ─── Agent definitions (mirrors specrails-core v5) ────────────────────────────
// specrails-core v5 ships exactly three first-party agents — there is nothing
// to select at install time. Specialists are added later via profiles that
// declare user-owned `custom-*` agents.

export interface AgentDef {
  id: string
  name: string
  description: string
  category: string
}

export const ALL_AGENTS: AgentDef[] = [
  { id: 'sr-architect', name: 'Architect', description: 'Architecture design, change specs, implementation planning', category: 'Core' },
  { id: 'sr-developer', name: 'Developer', description: 'Full-stack implementation across all layers', category: 'Core' },
  { id: 'sr-reviewer', name: 'Reviewer', description: 'General code review — the final quality gate', category: 'Core' },
]

// Core agents — the full shipped set in v5; the implementation pipeline depends on them
export const CORE_AGENTS = new Set(ALL_AGENTS.map((a) => a.id))

export const DEFAULT_SELECTED = new Set([...CORE_AGENTS])

// ─── AgentSelector (read-only core-team panel since core v5) ─────────────────

export function AgentSelector() {
  const { t } = useTranslation('agentstudio')

  return (
    <div className="space-y-4">
      <div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-accent-primary">
          {t('agentSelector.coreTeamTitle')}
        </span>
        <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
          {t('agentSelector.coreTeamNote')}
        </p>
      </div>

      <div className="space-y-1">
        {ALL_AGENTS.map((agent) => (
          <div
            key={agent.id}
            className="flex items-start gap-2.5 w-full text-left rounded-md px-2 py-1.5 bg-accent-primary/10"
          >
            <div className="w-3.5 h-3.5 rounded border bg-accent-primary border-accent-primary flex items-center justify-center flex-shrink-0 mt-0.5">
              <Check className="w-2.5 h-2.5 text-background" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">
                  {t(`agentSelector.agents.${agent.id}.name`, { defaultValue: agent.name })}
                </span>
                <span className="text-[9px] text-muted-foreground/60 font-mono truncate">
                  {agent.id}
                </span>
                <span className="flex items-center gap-0.5 text-[9px] text-accent-warning/80">
                  <Lock className="w-2.5 h-2.5" />
                  {t('agentSelector.coreBadge')}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                {t(`agentSelector.agents.${agent.id}.description`, { defaultValue: agent.description })}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
