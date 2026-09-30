import { isPublicProvider } from '../../providers/lib/provider-capabilities'
import { useTranslation } from 'react-i18next'
import { Cpu } from 'lucide-react'
import { isLocalEngineId, isRolesEngine, providerLabel } from '../../providers/lib/provider-capabilities'

interface Props {
  /** Selected engine. null/undefined = project primary; `roles` = the hybrid
   *  per-role engines (runtime config + loop roles). */
  value: string | null | undefined
  providers: readonly string[]
  onChange: (value: string) => void
}

/**
 * Compact rail-header AI engine selector. Renders nothing unless the project
 * has more than one provider installed (single-provider rails always use the
 * one engine, unchanged). Mirrors RailProfileSelector's dense styling.
 */
export function RailEngineSelector({ value, providers, onChange }: Props) {
  const { t } = useTranslation('agents')
  providers = providers.filter(isPublicProvider)
  if (providers.length <= 1) return null
  const current = isRolesEngine(value) ? providers[0] : value ?? providers[0]
  return (
    <div
      className="inline-flex items-center"
      title={t('railSelectors.engineTitle')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Cpu className="w-3 h-3 text-muted-foreground mr-1" />
      <select
        value={current}
        aria-label={t('railSelectors.engineTitle')}
        data-testid="rail-engine-selector"
        onChange={(e) => onChange(e.target.value)}
        className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {providers.map((p) => (
          <option key={p} value={p}>
            {isLocalEngineId(p) ? `${providerLabel(p)} · ${t('railSelectors.localEngine')}` : providerLabel(p)}
          </option>
        ))}
      </select>
    </div>
  )
}
