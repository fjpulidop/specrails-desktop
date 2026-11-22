import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import { API_ORIGIN } from '../../../lib/origin'
import { notifyError } from '../../../lib/notify-error'

export interface McpPreferences {
  confirmAboveUsd: number
  v2: { enabled: boolean; forcedByEnv: boolean }
}

/** Highest threshold the server accepts (MAX_CONFIRM_ABOVE_USD). */
const MAX_USD = 1000

/**
 * "Ask before spending" (the USD threshold above which a costly MCP call needs
 * the person's confirmation) and the switch for the new MCP surface.
 * Both go through `PATCH /api/mcp-admin/preferences`.
 */
export function McpPreferencesCard({ value, onChange }: { value: McpPreferences; onChange: (next: McpPreferences) => void }) {
  const { t } = useTranslation('mcp')
  const [draft, setDraft] = useState(String(value.confirmAboveUsd))
  const [busy, setBusy] = useState(false)

  useEffect(() => { setDraft(String(value.confirmAboveUsd)) }, [value.confirmAboveUsd])

  const save = async (patch: { confirmAboveUsd?: number; v2?: boolean }) => {
    setBusy(true)
    try {
      const r = await fetch(`${API_ORIGIN}/api/mcp-admin/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = (await r.json().catch(() => ({}))) as McpPreferences & { error?: string }
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      onChange({ confirmAboveUsd: body.confirmAboveUsd, v2: body.v2 })
    } catch (e) {
      setDraft(String(value.confirmAboveUsd))
      notifyError(t('preferences.saveFailed'), { detail: (e as Error).message, retry: () => void save(patch) })
    } finally {
      setBusy(false)
    }
  }

  const commit = () => {
    const parsed = Number(draft.replace(',', '.'))
    if (draft.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > MAX_USD) {
      setDraft(String(value.confirmAboveUsd))
      notifyError(t('preferences.thresholdInvalid', { max: MAX_USD }))
      return
    }
    if (parsed !== value.confirmAboveUsd) void save({ confirmAboveUsd: parsed })
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="mcp-preferences">
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="mcp-confirm-above" className="min-w-0">
          <span className="block text-sm font-medium">{t('preferences.threshold')}</span>
          <span className="block text-xs text-muted-foreground">{t('preferences.thresholdHelp')}</span>
        </label>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground" aria-hidden>$</span>
          <Input
            id="mcp-confirm-above"
            type="number"
            inputMode="decimal"
            min={0}
            max={MAX_USD}
            step={0.1}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
            className="h-7 w-20 tabular-nums"
          />
        </div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-medium" id="mcp-v2-label">{t('preferences.v2')}</span>
          <span className="block text-xs text-muted-foreground">
            {value.v2.forcedByEnv ? t('preferences.v2Forced') : t('preferences.v2Help')}
          </span>
        </div>
        <Switch
          checked={value.v2.enabled}
          disabled={busy || value.v2.forcedByEnv}
          onCheckedChange={(next) => void save({ v2: next })}
          aria-labelledby="mcp-v2-label"
        />
      </div>
    </div>
  )
}
