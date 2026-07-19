import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Plus, Trash2, Copy, Save, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { getApiBase } from '../../lib/api'
import { providerLabel } from '../../lib/provider-capabilities'
import { Button } from '../ui/button'
import { ProfileEditor } from './ProfileEditor'
import { ConfirmDialog, PromptDialog } from './PromptDialog'
import {
  BASELINE_REQUIRED_AGENTS,
  MODEL_ALIASES,
  type Profile,
  type ProfileListEntry,
  type ProfilesContext,
  type ProviderProfileCatalog,
} from './types'

const FALLBACK_CATALOG: ProviderProfileCatalog = {
  models: MODEL_ALIASES.map((value) => ({ value, label: value })),
  defaultModel: 'sonnet',
  baselineAgents: [...BASELINE_REQUIRED_AGENTS],
  customModelAliases: false,
}

const FALLBACK_CONTEXT: ProfilesContext = {
  primaryProvider: 'claude',
  providers: ['claude'],
  catalogs: { claude: FALLBACK_CATALOG },
}

export function buildNewProfile(
  name: string,
  provider: string,
  catalog: ProviderProfileCatalog,
): Profile {
  return {
    schemaVersion: 1,
    name,
    description: '',
    provider,
    orchestrator: { model: catalog.defaultModel },
    agents: catalog.baselineAgents.map((id) => ({
      id,
      model: catalog.defaultModel,
      required: true,
    })),
    routing: [{ default: true, agent: 'sr-developer' }],
  }
}

export function ProfilesTab() {
  const { t } = useTranslation('agents')
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([])
  const [profileContext, setProfileContext] = useState<ProfilesContext>(FALLBACK_CONTEXT)
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [validationIssues, setValidationIssues] = useState<string[]>([])
  const [agentsMissingRouting, setAgentsMissingRouting] = useState<string[]>([])
  const [createDialog, setCreateDialog] = useState(false)
  const [duplicateDialog, setDuplicateDialog] = useState<{ from: string } | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<{ name: string } | null>(null)
  const activeProvider = selectedProvider
  const activeCatalog = profileContext.catalogs[activeProvider] ?? FALLBACK_CATALOG

  useEffect(() => {
    let cancelled = false
    fetch(`${getApiBase()}/profiles/context`)
      .then((res) => {
        if (!res.ok) throw new Error('profile context unavailable')
        return res.json() as Promise<ProfilesContext>
      })
      .then((context) => {
        if (cancelled) return
        const providers = Array.isArray(context.providers) && context.providers.length > 0
          ? context.providers
          : [context.primaryProvider || 'claude']
        const primaryProvider = providers.includes(context.primaryProvider)
          ? context.primaryProvider
          : providers[0]
        setProfileContext({ ...context, providers, primaryProvider })
        setSelectedProvider(primaryProvider)
      })
      .catch(() => {
        if (!cancelled) {
          setProfileContext(FALLBACK_CONTEXT)
          setSelectedProvider(FALLBACK_CONTEXT.primaryProvider)
        }
      })
    return () => { cancelled = true }
  }, [])

  const refresh = useCallback(async () => {
    if (!activeProvider) return
    setLoading(true)
    setError(null)
    try {
      const profilesRes = await fetch(
        `${getApiBase()}/profiles?provider=${encodeURIComponent(activeProvider)}`,
      )
      if (!profilesRes.ok) throw new Error(t('profiles.errors.listFailed', { status: profilesRes.status }))
      const profilesData = (await profilesRes.json()) as { profiles: ProfileListEntry[] }
      setProfiles(profilesData.profiles)
      setSelected((current) =>
        current && profilesData.profiles.some((profile) => profile.name === current)
          ? current
          : profilesData.profiles[0]?.name ?? null,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [activeProvider, t])

  useEffect(() => {
    if (activeProvider) void refresh()
  }, [activeProvider, refresh])

  useEffect(() => {
    if (!selected) {
      setEditing(null)
      return
    }
    let cancelled = false
    fetch(
      `${getApiBase()}/profiles/${encodeURIComponent(selected)}?provider=${encodeURIComponent(activeProvider)}`,
    )
      .then((r) => {
        if (!r.ok) throw new Error(t('profiles.errors.loadFailed', { status: r.status }))
        return r.json() as Promise<{ profile: Profile }>
      })
      .then((data) => {
        if (!cancelled) setEditing(data.profile)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [activeProvider, selected, t])

  const migrateFromSettings = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `${getApiBase()}/profiles/migrate-from-settings?provider=${encodeURIComponent(activeProvider)}`,
        {
        method: 'POST',
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? t('profiles.errors.migrationFailed', { status: res.status }))
      }
      await refresh()
      setSelected('default')
      toast.success(t('profiles.toasts.migrated'), {
        description: t('profiles.toasts.migratedDescription'),
      })
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      toast.error(t('profiles.toasts.migrationFailed'), { description: message })
    } finally {
      setSaving(false)
    }
  }, [activeProvider, refresh, t])

  const doCreate = useCallback(
    async (trimmed: string) => {
      setCreateDialog(false)
      setSaving(true)
      setError(null)
      try {
        const body = buildNewProfile(trimmed, activeProvider, activeCatalog)
        const res = await fetch(
          `${getApiBase()}/profiles?provider=${encodeURIComponent(activeProvider)}`,
          {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error ?? t('profiles.errors.createFailed', { status: res.status }))
        }
        await refresh()
        setSelected(trimmed)
        toast.success(t('profiles.toasts.created'), { description: trimmed })
      } catch (e) {
        const message = (e as Error).message
        setError(message)
        toast.error(t('profiles.toasts.createFailed'), { description: message })
      } finally {
        setSaving(false)
      }
    },
    [activeCatalog, activeProvider, refresh, t],
  )

  const doDuplicate = useCallback(
    async (from: string, newName: string) => {
      setDuplicateDialog(null)
      setSaving(true)
      setError(null)
      try {
        const res = await fetch(
          `${getApiBase()}/profiles/${encodeURIComponent(from)}/duplicate?provider=${encodeURIComponent(activeProvider)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, provider: activeProvider }),
          },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error ?? t('profiles.errors.duplicateFailed', { status: res.status }))
        }
        await refresh()
        setSelected(newName)
        toast.success(t('profiles.toasts.duplicated'), {
          description: t('profiles.toasts.duplicatedDescription', { from, to: newName }),
        })
      } catch (e) {
        const message = (e as Error).message
        setError(message)
        toast.error(t('profiles.toasts.duplicateFailed'), { description: message })
      } finally {
        setSaving(false)
      }
    },
    [activeProvider, refresh, t],
  )

  const doRemove = useCallback(
    async (name: string) => {
      setDeleteDialog(null)
      setSaving(true)
      setError(null)
      try {
        const res = await fetch(
          `${getApiBase()}/profiles/${encodeURIComponent(name)}?provider=${encodeURIComponent(activeProvider)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error ?? t('profiles.errors.deleteFailed', { status: res.status }))
        }
        setSelected((prev) => (prev === name ? null : prev))
        await refresh()
        toast.success(t('profiles.toasts.deleted'), { description: name })
      } catch (e) {
        const message = (e as Error).message
        setError(message)
        toast.error(t('profiles.toasts.deleteFailed'), { description: message })
      } finally {
        setSaving(false)
      }
    },
    [activeProvider, refresh, t],
  )

  const createNew = useCallback(() => setCreateDialog(true), [])
  const duplicate = useCallback((name: string) => setDuplicateDialog({ from: name }), [])
  const remove = useCallback((name: string) => setDeleteDialog({ name }), [])

  const save = useCallback(async (profile: Profile, missingRouting: string[]) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        `${getApiBase()}/profiles/${encodeURIComponent(profile.name)}?provider=${encodeURIComponent(activeProvider)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...profile, provider: activeProvider }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? t('profiles.errors.saveFailed', { status: res.status }))
      }
      setEditing(profile)
      if (missingRouting.length > 0) {
        toast.warning(t('profiles.toasts.savedWithUntargeted'), {
          description: t('profiles.toasts.savedWithUntargetedDescription', {
            agents: missingRouting.join(', '),
          }),
          duration: 6000,
        })
      } else {
        toast.success(t('profiles.toasts.saved'), { description: profile.name })
      }
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      toast.error(t('profiles.toasts.saveFailed'), { description: message })
    } finally {
      setSaving(false)
    }
  }, [activeProvider, t])

  const dialogs = (
    <>
      <PromptDialog
        open={createDialog}
        title={t('profiles.createDialog.title')}
        description={t('profiles.createDialog.description')}
        placeholder="my-profile"
        confirmLabel={t('profiles.createDialog.confirmLabel')}
        inputPattern={/^[a-z0-9][a-z0-9-]*$/}
        inputInvalidHint={t('profiles.createDialog.invalidHint')}
        onConfirm={(v) => void doCreate(v)}
        onCancel={() => setCreateDialog(false)}
      />
      {duplicateDialog && (
        <PromptDialog
          open={true}
          title={t('profiles.duplicateDialog.title', { name: duplicateDialog.from })}
          description={t('profiles.duplicateDialog.description')}
          placeholder={`${duplicateDialog.from}-copy`}
          initialValue={`${duplicateDialog.from}-copy`}
          confirmLabel={t('common:actions.duplicate')}
          inputPattern={/^[a-z0-9][a-z0-9-]*$/}
          inputInvalidHint={t('profiles.duplicateDialog.invalidHint')}
          onConfirm={(v) => void doDuplicate(duplicateDialog.from, v)}
          onCancel={() => setDuplicateDialog(null)}
        />
      )}
      {deleteDialog && (
        <ConfirmDialog
          open={true}
          title={t('profiles.deleteDialog.title', { name: deleteDialog.name })}
          description={t('profiles.deleteDialog.description')}
          confirmLabel={t('common:actions.delete')}
          destructive
          onConfirm={() => void doRemove(deleteDialog.name)}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
    </>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">{t('profiles.loading')}</p>
      </div>
    )
  }

  if (profiles.length === 0) {
    return (
      <>
      {dialogs}
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="text-sm font-medium text-foreground">{t('profiles.empty.title')}</div>
          <div className="text-xs text-muted-foreground mt-1 mb-4">
            {t('profiles.empty.body')}
          </div>
          {profileContext.providers.length > 1 && (
            <select
              value={activeProvider}
              aria-label={t('profiles.providerLabel')}
              onChange={(event) => {
                setSelected(null)
                setEditing(null)
                setSelectedProvider(event.target.value)
              }}
              className="mb-4 h-8 w-full rounded border border-border bg-background px-2 text-xs"
            >
              {profileContext.providers.map((provider) => (
                <option key={provider} value={provider}>{providerLabel(provider)}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-2 justify-center">
            <Button size="sm" onClick={migrateFromSettings} disabled={saving}>
              <Wand2 className="w-3.5 h-3.5 mr-1.5" /> {t('profiles.empty.migrateButton')}
            </Button>
            <Button size="sm" variant="ghost" onClick={createNew} disabled={saving}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> {t('profiles.empty.blankButton')}
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-3">
            <Trans
              t={t}
              i18nKey="profiles.empty.migrateExplainer"
              components={{ code: <code className="text-foreground" /> }}
            />
          </div>
          {error && <div className="mt-3 text-xs text-red-400 aurora-light:text-destructive">{error}</div>}
        </div>
      </div>
      </>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {dialogs}
      <div className="flex flex-1 min-h-0">
      {/* Left: profile list */}
      <aside className="w-64 flex-shrink-0 border-r border-border flex flex-col">
        <div className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('profiles.sidebar.title')}
            </div>
            <Button size="sm" variant="ghost" onClick={createNew} disabled={saving}>
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
          {profileContext.providers.length > 1 && (
            <select
              value={activeProvider}
              aria-label={t('profiles.providerLabel')}
              onChange={(event) => {
                setSelected(null)
                setEditing(null)
                setSelectedProvider(event.target.value)
              }}
              className="h-7 w-full rounded border border-border bg-background px-2 text-xs"
            >
              {profileContext.providers.map((provider) => (
                <option key={provider} value={provider}>{providerLabel(provider)}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex-1 overflow-auto px-2 pb-3">
          {profiles.map((p) => {
            const isSelected = p.name === selected
            return (
              <div
                key={p.name}
                className={
                  'group mb-1 rounded-md px-2 py-1.5 text-xs cursor-pointer transition-colors flex items-center justify-between ' +
                  (isSelected
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')
                }
                onClick={() => setSelected(p.name)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelected(p.name)
                }}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium">{p.name}</span>
                  {p.isDefault && (
                    <span className="text-[10px] text-muted-foreground">{t('profiles.sidebar.teamDefault')}</span>
                  )}
                </div>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    className="p-1 hover:bg-accent rounded"
                    title={t('common:actions.duplicate')}
                    onClick={(e) => {
                      e.stopPropagation()
                      void duplicate(p.name)
                    }}
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                  {!p.isDefault && (
                    <button
                      type="button"
                      className="p-1 hover:bg-red-500/20 text-red-400 aurora-light:text-destructive rounded"
                      title={t('common:actions.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void remove(p.name)
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      {/* Right: editor */}
      <main className="flex-1 overflow-auto">
        {error && (
          <div className="mx-4 mt-4 px-3 py-2 text-xs rounded border border-red-500/30 aurora-light:border-destructive/30 bg-red-500/10 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive">
            {error}
          </div>
        )}
        {editing ? (
          <ProfileEditor
            key={`${activeProvider}:${editing.name}`}
            profile={editing}
            provider={activeProvider}
            modelCatalog={activeCatalog.models}
            defaultModel={activeCatalog.defaultModel}
            customModelAliases={activeCatalog.customModelAliases === true}
            baselineAgents={activeCatalog.baselineAgents}
            onChange={setEditing}
            onValidityChange={setValidationIssues}
            onSoftWarningsChange={(w) => setAgentsMissingRouting(w.agentsMissingRouting)}
            footer={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void save(editing, agentsMissingRouting)}
                  disabled={saving || validationIssues.length > 0}
                  title={validationIssues.length > 0 ? t('profiles.editorFooter.fixValidationIssues') : undefined}
                >
                  <Save className="w-3.5 h-3.5 mr-1.5" />
                  {t('common:actions.save')}
                </Button>
                {saving && <span className="text-xs text-muted-foreground">{t('common:states.saving')}</span>}
                {validationIssues.length > 0 && (
                  <span className="text-xs text-yellow-500 aurora-light:text-accent-warning">
                    {t('profiles.editorFooter.issuesToResolve', { count: validationIssues.length })}
                  </span>
                )}
              </div>
            }
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">{t('profiles.selectPrompt')}</p>
          </div>
        )}
      </main>
      </div>
    </div>
  )
}
