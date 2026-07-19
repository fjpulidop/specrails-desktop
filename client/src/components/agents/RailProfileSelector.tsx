import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'
import { getApiBase } from '../../lib/api'
import type { ProfileListEntry } from './types'

interface Props {
  provider: string
  /** null = legacy (no profile). undefined = not yet chosen; treated like null. */
  value: string | null
  onChange: (value: string | null) => void
}

const LEGACY_VALUE = '__legacy__'

/**
 * Compact rail-header profile selector. Hides itself if no profiles exist
 * in the project (rails default to legacy then). Auto-refreshes on mount.
 */
export function RailProfileSelector({ provider, value, onChange }: Props) {
  const { t } = useTranslation('agents')
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`${getApiBase()}/profiles?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ profiles: ProfileListEntry[] }>) : { profiles: [] }))
      .then((data) => {
        // A malformed/empty payload must degrade to "no profiles", never crash
        // the rail header render.
        if (cancelled) return
        const compatible = Array.isArray(data.profiles)
          ? data.profiles.filter((profile) => !profile.provider || profile.provider === provider)
          : []
        setProfiles(compatible)
        // An engine switch must not carry an incompatible profile into launch.
        if (value && !compatible.some((profile) => profile.name === value)) onChange(null)
      })
      .catch(() => {
        if (!cancelled) setProfiles([])
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [provider])

  if (!loaded) return null
  if (profiles.length === 0) return null

  const currentValue = value ?? LEGACY_VALUE

  return (
    <div
      className="inline-flex items-center"
      title={t('railSelectors.profileTitle')}
      // stop click from bubbling to the rail header's onMouseDown / long-press
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Bot className="w-3 h-3 text-muted-foreground mr-1" />
      <select
        value={currentValue}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === LEGACY_VALUE ? null : v)
        }}
        className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
        <option value={LEGACY_VALUE}>{t('railSelectors.noProfile')}</option>
      </select>
    </div>
  )
}
