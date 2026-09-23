import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { useDesktop } from '../../../hooks/useDesktop'
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type PartialTerminalSettings,
  type TerminalSettings,
  type TerminalRenderMode,
} from '../lib/terminal-settings-types'
import { dispatchTerminalSettingsUpdated } from '../lib/terminal-settings-events'

interface Props {
  /** Desktop mode edits desktop_settings; project mode edits a per-project override layer. */
  mode: 'desktop' | 'project'
}

interface ProjectResponse {
  resolved: TerminalSettings
  override: PartialTerminalSettings
  desktopDefaults: TerminalSettings
}

const RENDER_MODES: TerminalRenderMode[] = ['auto', 'canvas', 'webgl']

export function TerminalSettingsSection({ mode }: Props) {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()

  // Saved (last server-confirmed) state.
  const [desktop, setDesktop] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS)
  const [override, setOverride] = useState<PartialTerminalSettings>({})
  const [savedResolved, setSavedResolved] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS)

  // Draft (in-progress edits, not yet sent).
  const [draft, setDraft] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS)
  // Per-field "cleared override" flag — when true in project mode, the field
  // will be PATCHed with null on save to remove the override.
  const [clearedFields, setClearedFields] = useState<Set<keyof TerminalSettings>>(new Set())

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (mode === 'project' && !activeProjectId) {
      setLoading(false)
      return
    }
    void (async () => {
      try {
        if (mode === 'desktop') {
          const res = await fetch('/api/terminal-settings')
          if (!res.ok) throw new Error('desktop settings fetch failed')
          const body = (await res.json()) as TerminalSettings
          if (!cancelled && body && typeof body === 'object' && 'fontSize' in body) {
            setDesktop(body); setSavedResolved(body); setDraft(body)
            setClearedFields(new Set())
          }
          if (!cancelled) setLoading(false)
        } else if (activeProjectId) {
          const res = await fetch(`/api/projects/${activeProjectId}/terminal-settings`)
          if (!res.ok) throw new Error('project fetch failed')
          const body = (await res.json()) as ProjectResponse
          if (!cancelled && body && typeof body === 'object' && body.resolved && body.desktopDefaults) {
            setDesktop(body.desktopDefaults); setOverride(body.override ?? {}); setSavedResolved(body.resolved); setDraft(body.resolved)
            setClearedFields(new Set())
          }
          if (!cancelled) setLoading(false)
        }
      } catch (err) {
        if (!cancelled) { setLoading(false); console.error(err) }
      }
    })()
    return () => { cancelled = true }
  }, [mode, activeProjectId])

  const dirty = useMemo(() => {
    if (clearedFields.size > 0) return true
    return (Object.keys(draft) as Array<keyof TerminalSettings>).some(
      (k) => draft[k] !== savedResolved[k],
    )
  }, [draft, savedResolved, clearedFields])

  function setField<K extends keyof TerminalSettings>(field: K, value: TerminalSettings[K]): void {
    setDraft((d) => ({ ...d, [field]: value }))
    // If user re-edits a previously-cleared field, drop the clear flag.
    if (clearedFields.has(field)) {
      setClearedFields((prev) => { const next = new Set(prev); next.delete(field); return next })
    }
  }

  function clearOverride(field: keyof TerminalSettings): void {
    if (mode !== 'project') return
    // Mark for null-PATCH on save and reset draft to the desktop default value
    // so the user immediately sees what they'll get.
    setClearedFields((prev) => { const next = new Set(prev); next.add(field); return next })
    setDraft((d) => ({ ...d, [field]: desktop[field] }))
  }

  function reset(): void {
    setDraft(savedResolved)
    setClearedFields(new Set())
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      // Build the partial PATCH body from draft vs savedResolved diff + cleared fields.
      const body: Record<string, unknown> = {}
      for (const k of Object.keys(draft) as Array<keyof TerminalSettings>) {
        if (clearedFields.has(k)) {
          body[k] = null
          continue
        }
        if (draft[k] !== savedResolved[k]) body[k] = draft[k]
      }
      if (Object.keys(body).length === 0) { toast(t('terminal.nothingToSave')); setSaving(false); return }

      if (mode === 'desktop') {
        const res = await fetch('/api/terminal-settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.text()) || 'patch failed')
        const updated = (await res.json()) as TerminalSettings
        setDesktop(updated); setSavedResolved(updated); setDraft(updated); setClearedFields(new Set())
        dispatchTerminalSettingsUpdated({ mode: 'desktop', projectId: null })
        toast.success(t('terminal.saved'))
      } else if (activeProjectId) {
        const res = await fetch(`/api/projects/${activeProjectId}/terminal-settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.text()) || 'patch failed')
        const updated = (await res.json()) as ProjectResponse
        setDesktop(updated.desktopDefaults); setOverride(updated.override); setSavedResolved(updated.resolved); setDraft(updated.resolved)
        setClearedFields(new Set())
        dispatchTerminalSettingsUpdated({ mode: 'project', projectId: activeProjectId })
        toast.success(t('terminal.saved'))
      }
    } catch (err) {
      toast.error(t('errors.saveFailed', { message: (err as Error).message }))
    } finally {
      setSaving(false)
    }
  }

  function isOverridden(field: keyof TerminalSettings): boolean {
    if (mode !== 'project') return false
    if (clearedFields.has(field)) return false
    return override[field] !== undefined
  }

  if (loading) return <Card><CardContent>{t('common:states.loading')}</CardContent></Card>

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('terminal.title')}</CardTitle>
        <CardDescription>
          {mode === 'desktop'
            ? t('terminal.desktopDescription')
            : t('terminal.projectDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label={t('terminal.fontFamily')} overridden={isOverridden('fontFamily')} onClear={() => clearOverride('fontFamily')} mode={mode}>
          <Input
            value={draft.fontFamily}
            onChange={(e) => setField('fontFamily', e.target.value)}
          />
        </Field>

        <Field label={t('terminal.fontSize', { min: TERMINAL_FONT_SIZE_MIN, max: TERMINAL_FONT_SIZE_MAX })} overridden={isOverridden('fontSize')} onClear={() => clearOverride('fontSize')} mode={mode}>
          <Input
            type="number"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            value={draft.fontSize}
            onChange={(e) => setField('fontSize', parseInt(e.target.value, 10) || draft.fontSize)}
          />
        </Field>

        <Field label={t('terminal.renderMode')} overridden={isOverridden('renderMode')} onClear={() => clearOverride('renderMode')} mode={mode}>
          <select
            value={draft.renderMode}
            onChange={(e) => setField('renderMode', e.target.value as TerminalRenderMode)}
            className="border rounded px-2 py-1 bg-transparent"
          >
            {RENDER_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>

        <ToggleField
          label={t('terminal.copyOnSelect')}
          checked={draft.copyOnSelect}
          overridden={isOverridden('copyOnSelect')}
          onClear={() => clearOverride('copyOnSelect')}
          onChange={(v) => setField('copyOnSelect', v)}
          mode={mode}
        />

        <ToggleField
          label={t('terminal.shellIntegration')}
          checked={draft.shellIntegrationEnabled}
          overridden={isOverridden('shellIntegrationEnabled')}
          onClear={() => clearOverride('shellIntegrationEnabled')}
          onChange={(v) => setField('shellIntegrationEnabled', v)}
          mode={mode}
        />

        <ToggleField
          label={t('terminal.notifyLongRunning')}
          checked={draft.notifyOnCompletion}
          overridden={isOverridden('notifyOnCompletion')}
          onClear={() => clearOverride('notifyOnCompletion')}
          onChange={(v) => setField('notifyOnCompletion', v)}
          mode={mode}
        />

        <Field label={t('terminal.longCommandThreshold')} overridden={isOverridden('longCommandThresholdMs')} onClear={() => clearOverride('longCommandThresholdMs')} mode={mode}>
          <Input
            type="number"
            min={1000}
            value={draft.longCommandThresholdMs}
            onChange={(e) => setField('longCommandThresholdMs', parseInt(e.target.value, 10) || draft.longCommandThresholdMs)}
          />
        </Field>

        <ToggleField
          label={t('terminal.imageRendering')}
          checked={draft.imageRendering}
          overridden={isOverridden('imageRendering')}
          onClear={() => clearOverride('imageRendering')}
          onChange={(v) => setField('imageRendering', v)}
          mode={mode}
        />

        <Field id="terminal-browser-shortcut-url" label={t('terminal.browserShortcutUrl')} overridden={isOverridden('browserShortcutUrl')} onClear={() => clearOverride('browserShortcutUrl')} mode={mode}>
          <Input
            type="url"
            value={draft.browserShortcutUrl}
            placeholder="https://specrails.dev"
            onChange={(e) => setField('browserShortcutUrl', e.target.value)}
          />
        </Field>

        <Field id="terminal-quick-script" label={t('terminal.quickScript')} overridden={isOverridden('quickScript')} onClear={() => clearOverride('quickScript')} mode={mode}>
          <textarea
            value={draft.quickScript}
            placeholder='echo "Hello World!"'
            onChange={(e) => setField('quickScript', e.target.value)}
            rows={3}
            className="w-full border rounded px-2 py-1 bg-transparent font-mono text-xs"
          />
        </Field>

        <div className="flex items-center gap-2 pt-2 border-t">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </Button>
          <Button variant="ghost" onClick={reset} disabled={!dirty || saving}>
            {t('terminal.reset')}
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">{t('terminal.unsavedChanges')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function Field({ id, label, overridden, onClear, mode, children }: { id?: string; label: string; overridden: boolean; onClear: () => void; mode: 'desktop' | 'project'; children: React.ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <div id={id} data-terminal-settings-anchor={id ? '' : undefined} className={id ? 'scroll-mt-4' : undefined}>
      <div className="flex justify-between items-center mb-1">
        <label className="text-sm font-medium">{label}</label>
        {mode === 'project' && overridden && (
          <Button variant="ghost" size="sm" onClick={onClear}>{t('terminal.clearOverride')}</Button>
        )}
      </div>
      {children}
      {mode === 'project' && !overridden && (
        <p className="text-xs text-muted-foreground mt-1">{t('terminal.inheritingDefault')}</p>
      )}
    </div>
  )
}

function ToggleField({ label, checked, overridden, onClear, onChange, mode }: { label: string; checked: boolean; overridden: boolean; onClear: () => void; onChange: (v: boolean) => void; mode: 'desktop' | 'project' }) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex justify-between items-center">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        {mode === 'project' && overridden && (
          <Button variant="ghost" size="sm" onClick={onClear}>{t('terminal.clear')}</Button>
        )}
        <button
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
            checked ? 'bg-primary' : 'bg-input'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform ${
              checked ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    </div>
  )
}
