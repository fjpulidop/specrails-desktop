import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { getApiBase } from '../../lib/api'
import type { ProviderId } from '../../lib/provider-capabilities'

export interface SpecModelOption {
  value: string
  label: string
}

export interface DefaultSpecModelResponse {
  model: string
  provider: ProviderId
  allowed: SpecModelOption[]
  /** All providers installed for the project (multi-provider AI Engine selector). */
  providers?: (ProviderId)[]
}

interface SpecModelPickerProps {
  /** Selected model id. `null` means "not yet resolved" (loading). */
  value: string | null
  /** Allowed list to render. Empty while loading. */
  allowed: SpecModelOption[]
  loading: boolean
  onChange: (next: string) => void
  ariaLabel?: string
}

export function SpecModelPicker({ value, allowed, loading, onChange, ariaLabel }: SpecModelPickerProps) {
  const { t } = useTranslation('explore')
  return (
    <Select value={value ?? ''} onValueChange={onChange} disabled={loading || allowed.length === 0}>
      <SelectTrigger
        className="h-8 w-[160px] text-xs gap-1.5"
        aria-label={ariaLabel ?? t('modelPicker.ariaLabel')}
        data-testid="spec-model-picker"
      >
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('common:states.loading')}
          </span>
        ) : (
          <SelectValue placeholder={t('modelPicker.placeholder')} />
        )}
      </SelectTrigger>
      <SelectContent>
        {allowed.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Fetch the project's default Add-Spec model + the provider's allow-list.
 * Auto-runs when `enabled` flips to true (typically: modal opened) and again
 * on `projectId` change. Falls back to a tiny local list if the endpoint
 * fails so the modal stays usable; surface this via `error`.
 */
export function useDefaultSpecModel(
  projectId: string | null,
  enabled: boolean,
  /** Optional engine override (multi-provider). When set, the endpoint returns
   *  that provider's default model + allow-list. Refetches when it changes. */
  providerOverride?: ProviderId | null,
) {
  const [model, setModel] = useState<string | null>(null)
  const [allowed, setAllowed] = useState<SpecModelOption[]>([])
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [providers, setProviders] = useState<(ProviderId)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !projectId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = providerOverride ? `?provider=${encodeURIComponent(providerOverride)}` : ''
    fetch(`${getApiBase()}/default-spec-model${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<DefaultSpecModelResponse>
      })
      .then((data) => {
        if (cancelled) return
        setModel(typeof data?.model === 'string' ? data.model : 'sonnet')
        setAllowed(Array.isArray(data?.allowed) && data.allowed.length > 0
          ? data.allowed
          : [{ value: 'sonnet', label: 'Claude Sonnet' }])
        setProvider(data?.provider ?? 'claude')
        setProviders(Array.isArray(data?.providers) && data.providers.length > 0
          ? data.providers
          : [data?.provider ?? 'claude'])
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        // Conservative client-side fallback: claude/sonnet so the modal can
        // still submit. Server re-validates and resolves on its side.
        setModel('sonnet')
        setAllowed([{ value: 'sonnet', label: 'Claude Sonnet' }])
        setProvider('claude')
        setProviders(['claude'])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [enabled, projectId, providerOverride])

  return { model, setModel, allowed, provider, providers, loading, error }
}
