import { GlobalSubagentsSection } from '../components/SubagentsSettingsSection'
import type { AppSettingsSection } from '../../../lib/app-settings-events'
import { SubscriptionUsagePanel } from '../../subscription-usage/components/SubscriptionUsagePanel'
import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useTranslation, Trans } from 'react-i18next'
import { TerminalSettingsSection } from '../components/TerminalSettingsSection'
import { EffectsSection } from '../components/EffectsSection'
import { AppearanceSection } from '../components/AppearanceSection'
import { LanguageSection } from '../components/LanguageSection'
import { CodeSectionSettings } from '../components/CodeSectionSettings'
import { ProviderConnectionsCard } from '../components/provider-connections'
import { CoreUpdateSection } from '../components/CoreUpdateSection'
import { AppUpdateSection } from '../components/AppUpdateSection'
import { UpdateChannelSection } from '../components/UpdateChannelSection'
import { MobileAccessSection } from '../components/MobileAccessSection'
import { McpSettingsSection } from '../components/McpSettingsSection'
import { FEATURE_MCP } from '../../../lib/feature-flags'
import { Settings, Trash2, Zap, Plus, Bell, GraduationCap, Palette, Code2, RefreshCw, Smartphone, Bot, Cpu, FolderOpen, SlidersHorizontal, Webhook, Info, TerminalSquare, Sparkles, Gauge, Save } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { SettingsCard } from '../components/SettingsCard'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog'
import { useDesktop } from '../../../hooks/useDesktop'
import type { DesktopProject } from '../../../hooks/useDesktop'
import {
  getOsNotificationPrefs,
  setOsNotificationPrefs,
  type OsNotificationFilter,
} from '../../../hooks/useOsNotifications'

type WebhookEvent = 'job.completed' | 'job.failed' | 'daily_budget_exceeded'

const WEBHOOK_EVENTS: { value: WebhookEvent; labelKey: string }[] = [
  { value: 'job.completed', labelKey: 'webhooks.eventJobCompleted' },
  { value: 'job.failed', labelKey: 'webhooks.eventJobFailed' },
  { value: 'daily_budget_exceeded', labelKey: 'webhooks.eventDailyBudgetExceeded' },
]

interface WebhookRow {
  id: string
  project_id: string | null
  url: string
  secret: string
  events: string
  enabled: number
  created_at: string
}

interface DesktopSettings {
  port: number
  specrailsTechUrl: string
  costAlertThresholdUsd: number | null
}

interface SettingsDialogProps {
  initialSection?: AppSettingsSection
  open: boolean
  onClose: () => void
  onOpenOnboarding?: () => void
}

function ProjectListItem({
  project,
  onRemove,
}: {
  project: DesktopProject
  onRemove: (project: DesktopProject) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-md border border-border">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{project.name}</p>
        <p className="text-xs text-muted-foreground truncate">{project.path}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive shrink-0"
        onClick={() => onRemove(project)}
      >
        {t('common:actions.remove')}
      </Button>
    </div>
  )
}

// Left-nav sections for the two-pane settings layout, grouped under three
// labels. Each id matches a pane wrapper in the content area; contiguous
// settings blocks are grouped per tab.
const SETTINGS_GROUPS = [
  {
    id: 'personal',
    labelKey: 'desktop.navGroups.personal',
    items: [
      { id: 'appearance', icon: Palette, labelKey: 'desktop.nav.appearance' },
      { id: 'effects', icon: Sparkles, labelKey: 'desktop.nav.effects' },
      { id: 'code', icon: Code2, labelKey: 'desktop.nav.code' },
      { id: 'terminal', icon: TerminalSquare, labelKey: 'desktop.nav.terminal' },
    ],
  },
  {
    id: 'agents',
    labelKey: 'desktop.navGroups.agents',
    items: [
      { id: 'specrailsAgents', icon: Cpu, labelKey: 'desktop.nav.specrailsAgents' },
      { id: 'subscriptionUsage', icon: Gauge, labelKey: 'desktop.nav.subscriptionUsage' },
      { id: 'mcp', icon: Bot, labelKey: 'desktop.nav.mcp' },
      { id: 'mobile', icon: Smartphone, labelKey: 'desktop.nav.mobile' },
    ],
  },
  {
    id: 'system',
    labelKey: 'desktop.navGroups.system',
    items: [
      { id: 'projects', icon: FolderOpen, labelKey: 'desktop.nav.projects' },
      { id: 'advanced', icon: SlidersHorizontal, labelKey: 'desktop.nav.advanced' },
      { id: 'webhooks', icon: Webhook, labelKey: 'desktop.nav.webhooks' },
      { id: 'updates', icon: RefreshCw, labelKey: 'desktop.nav.updates' },
      { id: 'about', icon: Info, labelKey: 'desktop.nav.about' },
    ],
  },
] as const

/** Trimmed form value of an optional USD amount ('' when unset). */
function amountValue(value: number | null | undefined): string {
  return value != null ? String(value) : ''
}

export default function SettingsDialog({ open, onClose, onOpenOnboarding, initialSection = 'appearance' }: SettingsDialogProps) {
  const { t } = useTranslation('settings')
  const { projects, removeProject } = useDesktop()
  const [activeSection, setActiveSection] = useState<string>('appearance')
  useEffect(() => {
    if (open) setActiveSection(initialSection)
  }, [open, initialSection])
  const paneCls = (id: string) => cn('space-y-5', activeSection === id ? '' : 'hidden')
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null)
  // Advanced pane: draft vs last-saved values feed one dirty save bar.
  const [costAlertThreshold, setCostAlertThreshold] = useState('')
  const [savedCostAlertThreshold, setSavedCostAlertThreshold] = useState('')
  const [desktopDailyBudget, setDesktopDailyBudget] = useState('')
  const [savedDesktopDailyBudget, setSavedDesktopDailyBudget] = useState('')
  const [isSavingAdvanced, setIsSavingAdvanced] = useState(false)
  const advancedDirty = costAlertThreshold !== savedCostAlertThreshold || desktopDailyBudget !== savedDesktopDailyBudget

  // Destructive-action confirmations
  const [pendingRemoveProject, setPendingRemoveProject] = useState<DesktopProject | null>(null)
  const [pendingDeleteWebhook, setPendingDeleteWebhook] = useState<WebhookRow | null>(null)

  // Webhook state
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([])
  const [newWebhookUrl, setNewWebhookUrl] = useState('')
  const [newWebhookSecret, setNewWebhookSecret] = useState('')
  const [newWebhookEvents, setNewWebhookEvents] = useState<WebhookEvent[]>(['job.completed', 'job.failed'])
  const [isAddingWebhook, setIsAddingWebhook] = useState(false)

  // OS Notification preferences (localStorage)
  const [notifEnabled, setNotifEnabled] = useState(() => getOsNotificationPrefs().enabled)
  const [notifFilter, setNotifFilter] = useState<OsNotificationFilter>(() => getOsNotificationPrefs().filter)

  function handleToggleNotifications(enabled: boolean) {
    setNotifEnabled(enabled)
    setOsNotificationPrefs({ enabled, filter: notifFilter })
    toast.success(enabled ? t('notifications.enabledToast') : t('notifications.disabledToast'))
  }

  function handleNotifFilterChange(filter: OsNotificationFilter) {
    setNotifFilter(filter)
    setOsNotificationPrefs({ enabled: notifEnabled, filter })
  }

  const loadWebhooks = useCallback(async () => {
    try {
      const res = await fetch('/api/webhooks')
      if (res.ok) {
        const data = await res.json() as { webhooks: WebhookRow[] }
        setWebhooks(data.webhooks)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!open) return
    async function load() {
      try {
        const res = await fetch('/api/settings')
        if (res.ok) {
          const data = await res.json() as DesktopSettings
          setDesktopSettings(data)
          setCostAlertThreshold(amountValue(data.costAlertThresholdUsd))
          setSavedCostAlertThreshold(amountValue(data.costAlertThresholdUsd))
        }
      } catch {
        // ignore — the panes render with their defaults
      }
    }
    load()
    void loadWebhooks()
  }, [open, loadWebhooks])

  useEffect(() => {
    if (!open) return
    fetch('/api/budget')
      .then((r) => r.json())
      .then((data: { desktopDailyBudgetUsd?: number | null }) => {
        setDesktopDailyBudget(amountValue(data.desktopDailyBudgetUsd))
        setSavedDesktopDailyBudget(amountValue(data.desktopDailyBudgetUsd))
      })
      .catch(() => {})
  }, [open])

  /** Persists the per-job cost alert threshold. Returns true on success. */
  async function saveCostAlertThreshold(): Promise<boolean> {
    try {
      const parsed = costAlertThreshold.trim() === '' ? null : parseFloat(costAlertThreshold)
      if (parsed !== null && (isNaN(parsed) || parsed <= 0)) {
        toast.error(t('budget.invalidNumber'))
        return false
      }
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costAlertThresholdUsd: parsed }),
      })
      if (res.ok) {
        setSavedCostAlertThreshold(costAlertThreshold)
        toast.success(parsed == null ? t('desktop.costAlertsDisabled') : t('budget.alertSet', { amount: parsed }))
        return true
      }
      toast.error(t('budget.saveThresholdFailed'))
    } catch {
      toast.error(t('budget.saveThresholdFailed'))
    }
    return false
  }

  /** Persists the Desktop-wide daily budget. Returns true on success. */
  async function saveDesktopDailyBudget(): Promise<boolean> {
    try {
      const val = desktopDailyBudget.trim() === '' ? null : parseFloat(desktopDailyBudget)
      if (val !== null && (isNaN(val) || val <= 0)) {
        toast.error(t('budget.invalidNumber'))
        return false
      }
      const res = await fetch('/api/budget', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktopDailyBudgetUsd: val }),
      })
      if (res.ok) {
        setSavedDesktopDailyBudget(desktopDailyBudget)
        toast.success(val == null ? t('desktop.dailyBudgetRemoved') : t('desktop.dailyBudgetSet', { amount: val }))
        return true
      }
      toast.error(t('desktop.dailyBudgetSaveFailed'))
    } catch {
      toast.error(t('desktop.dailyBudgetSaveFailed'))
    }
    return false
  }

  /** One save for the whole Advanced pane: only the edited fields are sent. */
  async function handleSaveAdvanced() {
    setIsSavingAdvanced(true)
    try {
      if (desktopDailyBudget !== savedDesktopDailyBudget) await saveDesktopDailyBudget()
      if (costAlertThreshold !== savedCostAlertThreshold) await saveCostAlertThreshold()
    } finally {
      setIsSavingAdvanced(false)
    }
  }

  async function handleRemoveProject(id: string) {
    try {
      await removeProject(id)
      toast.success(t('desktop.projectRemoved'))
    } catch (err) {
      toast.error(t('desktop.projectRemoveFailed'), { description: (err as Error).message })
    }
  }

  async function handleAddWebhook() {
    if (!newWebhookUrl.trim()) {
      toast.error(t('webhooks.urlRequired'))
      return
    }
    if (newWebhookEvents.length === 0) {
      toast.error(t('webhooks.selectEvent'))
      return
    }
    setIsAddingWebhook(true)
    try {
      const res = await fetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newWebhookUrl.trim(), secret: newWebhookSecret.trim(), events: newWebhookEvents }),
      })
      if (res.ok) {
        toast.success(t('webhooks.added'))
        setNewWebhookUrl('')
        setNewWebhookSecret('')
        setNewWebhookEvents(['job.completed', 'job.failed'])
        await loadWebhooks()
      } else {
        const err = await res.json() as { error?: string }
        toast.error(err.error ?? t('webhooks.addFailed'))
      }
    } catch {
      toast.error(t('webhooks.addFailed'))
    } finally {
      setIsAddingWebhook(false)
    }
  }

  async function handleToggleWebhook(id: string, enabled: boolean) {
    try {
      const res = await fetch(`/api/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) toast.error(t('webhooks.updateFailed'))
      await loadWebhooks()
    } catch {
      toast.error(t('webhooks.updateFailed'))
    }
  }

  async function handleDeleteWebhook(id: string) {
    try {
      const res = await fetch(`/api/webhooks/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(t('webhooks.removed'))
        await loadWebhooks()
      } else {
        toast.error(t('webhooks.removeFailed'))
      }
    } catch {
      toast.error(t('webhooks.removeFailed'))
    }
  }

  async function handleTestWebhook(id: string) {
    try {
      const res = await fetch(`/api/webhooks/${id}/test`, { method: 'POST' })
      if (res.ok) {
        toast.success(t('webhooks.testPingSent'))
      } else {
        toast.error(t('webhooks.testPingFailed'))
      }
    } catch {
      toast.error(t('webhooks.testPingFailed'))
    }
  }

  function toggleNewEvent(event: WebhookEvent) {
    setNewWebhookEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    )
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent movableResizable className="flex max-w-5xl w-[92vw] h-[82vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" aria-hidden />
            {t('desktop.title')}
          </DialogTitle>
          <DialogDescription>
            {t('desktop.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-5 py-2">
          {/* Left section nav, grouped Personal · Agents · System */}
          <nav aria-label={t('desktop.navLabel')} className="w-40 shrink-0 overflow-y-auto border-r border-border pr-2">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.id} role="group" aria-labelledby={`settings-nav-group-${group.id}`} className="space-y-0.5">
                <p id={`settings-nav-group-${group.id}`} className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground first:pt-0">
                  {t(group.labelKey)}
                </p>
                {group.items.map((s) => {
                  if (s.id === 'mcp' && !FEATURE_MCP) return null
                  const Icon = s.icon
                  const active = activeSection === s.id
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setActiveSection(s.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'bg-accent-primary/15 font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                      )}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{t(s.labelKey)}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>

          {/* Active section content — fills the fixed-height dialog and scrolls,
              so switching sections never resizes the modal. */}
          <div className="min-w-0 flex-1 overflow-y-auto pr-1 pb-4">
            <div className={paneCls('appearance')}>
              <AppearanceSection />
              <LanguageSection />
              {onOpenOnboarding && (
                <SettingsCard title={t('desktop.onboardingHeading')}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium">{t('desktop.platformTour')}</p>
                      <p className="text-xs text-muted-foreground">{t('desktop.platformTourDescription')}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs shrink-0"
                      onClick={onOpenOnboarding}
                      data-testid="replay-onboarding"
                    >
                      <GraduationCap className="w-3 h-3 mr-1" aria-hidden />
                      {t('desktop.replayTour')}
                    </Button>
                  </div>
                </SettingsCard>
              )}
            </div>

            <div className={paneCls('effects')}>
              <EffectsSection />
            </div>

            <div className={paneCls('specrailsAgents')}>
              <ProviderConnectionsCard />
              <GlobalSubagentsSection />
            </div>

            {activeSection === 'subscriptionUsage' && <SubscriptionUsagePanel showDataDetails />}

            <div className={paneCls('code')}>
              <CodeSectionSettings />
            </div>

            <div className={paneCls('updates')}>
              <UpdateChannelSection />
              <AppUpdateSection />
              <CoreUpdateSection />
            </div>

            <div className={paneCls('mobile')}>
              <MobileAccessSection />
            </div>

            {FEATURE_MCP && <div className={paneCls('mcp')}><McpSettingsSection /></div>}

            <div className={paneCls('projects')}>
              <SettingsCard title={t('desktop.registeredProjects')}>
                {projects.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-center">
                    <p className="text-xs text-muted-foreground">{t('desktop.noProjects')}</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {projects.map((project) => (
                      <ProjectListItem
                        key={project.id}
                        project={project}
                        onRemove={setPendingRemoveProject}
                      />
                    ))}
                  </div>
                )}
              </SettingsCard>
            </div>

            <div className={paneCls('advanced')}>
              <SettingsCard title={t('desktop.budgetAlertsHeading')} contentClassName="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="settings-daily-budget" className="text-xs font-medium">{t('desktop.dailyBudgetLabel')}</label>
                  <p className="text-xs text-muted-foreground">{t('desktop.dailyBudgetHelper')}</p>
                  <Input
                    id="settings-daily-budget"
                    type="number"
                    min="0"
                    step="0.01"
                    value={desktopDailyBudget}
                    onChange={(e) => setDesktopDailyBudget(e.target.value)}
                    placeholder={t('desktop.dailyBudgetPlaceholder')}
                    className="h-7 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5 border-t border-border pt-3">
                  <label htmlFor="settings-cost-alert" className="text-xs font-medium">{t('budget.perJobLabel')}</label>
                  <p className="text-xs text-muted-foreground">{t('desktop.perJobHelper')}</p>
                  <Input
                    id="settings-cost-alert"
                    type="number"
                    min="0"
                    step="0.01"
                    value={costAlertThreshold}
                    onChange={(e) => setCostAlertThreshold(e.target.value)}
                    placeholder={t('budget.perJobPlaceholder')}
                    className="h-7 text-xs font-mono"
                  />
                </div>
              </SettingsCard>

              <SettingsCard title={t('notifications.heading')} description={t('notifications.description')}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifEnabled}
                    onChange={(e) => handleToggleNotifications(e.target.checked)}
                    className="h-4 w-4"
                    data-testid="notif-toggle"
                  />
                  <Bell className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
                  <span className="text-xs">{t('notifications.enableLabel')}</span>
                </label>
                {notifEnabled && (
                  <fieldset className="space-y-1.5 pl-6">
                    <legend className="text-xs text-muted-foreground">{t('notifications.notifyOn')}</legend>
                    <div className="flex flex-wrap gap-3">
                      {([
                        { value: 'all' as const, label: t('notifications.filterAll') },
                        { value: 'completed' as const, label: t('notifications.filterCompleted') },
                        { value: 'failed' as const, label: t('notifications.filterFailed') },
                      ]).map(({ value, label }) => (
                        <label key={value} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="radio"
                            name="notif-filter"
                            checked={notifFilter === value}
                            onChange={() => handleNotifFilterChange(value)}
                            className="h-4 w-4"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </SettingsCard>

              {/* One save bar for the pane, matching Settings ▸ AI providers. */}
              <div
                className={cn(
                  'flex flex-wrap items-center justify-end gap-3 rounded-xl px-3 py-2 transition-colors duration-200',
                  advancedDirty && 'sticky bottom-0 z-20 border border-accent-warning/30 bg-popover shadow-lg',
                )}
                data-testid="advanced-save-bar"
                data-sticky={advancedDirty}
              >
                {advancedDirty && (
                  <span className="mr-auto inline-flex h-6 items-center gap-1.5 rounded-full border border-accent-warning/30 bg-accent-warning/10 px-2.5 text-[11px] font-medium text-accent-warning" role="status">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-warning" />
                    {t('desktop.unsavedChanges')}
                  </span>
                )}
                <Button disabled={isSavingAdvanced || !advancedDirty} className="gap-1.5" onClick={() => void handleSaveAdvanced()}>
                  <Save className="h-3.5 w-3.5" aria-hidden />
                  {isSavingAdvanced ? t('common:states.saving') : t('common:actions.save')}
                </Button>
              </div>
            </div>

            <div className={paneCls('webhooks')}>
              <SettingsCard
                title={t('webhooks.heading')}
                description={
                  <Trans
                    ns="settings"
                    i18nKey="webhooks.description"
                    components={{ code: <code className="font-mono" /> }}
                  />
                }
              >
                {webhooks.length > 0 && (
                  <div className="space-y-1.5">
                    {webhooks.map((wh) => {
                      const events: string[] = (() => { try { return JSON.parse(wh.events) as string[] } catch { return [] } })()
                      return (
                        <div key={wh.id} className="flex items-start gap-2 rounded-md border border-border p-2">
                          <div className="flex-1 min-w-0 space-y-0.5">
                            <p className="text-xs font-mono truncate">{wh.url}</p>
                            <p className="text-xs text-muted-foreground">{events.join(', ')}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Switch
                              checked={!!wh.enabled}
                              onCheckedChange={(next) => void handleToggleWebhook(wh.id, next)}
                              onClassName="bg-accent-success"
                              aria-label={t('webhooks.enable')}
                              title={wh.enabled ? t('webhooks.disable') : t('webhooks.enable')}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => void handleTestWebhook(wh.id)}
                              title={t('webhooks.sendTestPing')}
                              aria-label={t('webhooks.sendTestPing')}
                            >
                              <Zap className="w-3.5 h-3.5" aria-hidden />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => setPendingDeleteWebhook(wh)}
                              title={t('common:actions.remove')}
                              aria-label={t('common:actions.remove')}
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="space-y-2 border-t border-border pt-2">
                  <p className="text-xs font-medium text-muted-foreground">{t('webhooks.addHeading')}</p>
                  <Input
                    value={newWebhookUrl}
                    onChange={(e) => setNewWebhookUrl(e.target.value)}
                    placeholder="https://hooks.example.com/..."
                    aria-label={t('webhooks.urlLabel')}
                    className="h-7 text-xs font-mono"
                  />
                  <Input
                    type="password"
                    autoComplete="off"
                    value={newWebhookSecret}
                    onChange={(e) => setNewWebhookSecret(e.target.value)}
                    placeholder={t('webhooks.secretPlaceholder')}
                    aria-label={t('webhooks.secretPlaceholder')}
                    className="h-7 text-xs font-mono"
                  />
                  <div className="flex flex-wrap gap-3">
                    {WEBHOOK_EVENTS.map(({ value, labelKey }) => (
                      <label key={value} className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newWebhookEvents.includes(value)}
                          onChange={() => toggleNewEvent(value)}
                          className="h-4 w-4"
                        />
                        {t(labelKey)}
                      </label>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-xs w-full"
                    disabled={isAddingWebhook || !newWebhookUrl.trim()}
                    onClick={() => void handleAddWebhook()}
                  >
                    <Plus className="w-3 h-3 mr-1" aria-hidden />
                    {t('webhooks.addButton')}
                  </Button>
                </div>
              </SettingsCard>
            </div>

            <div className={paneCls('terminal')}>
              <TerminalSettingsSection mode="desktop" />
            </div>

            <div className={paneCls('about')}>
              <SettingsCard title={t('desktop.infoHeading')} contentClassName="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('desktop.infoPort')}</span>
                  <span className="font-mono">{desktopSettings?.port ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('desktop.infoProjects')}</span>
                  <span className="font-mono">{projects.length}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('desktop.infoDb')}</span>
                  <span className="font-mono text-muted-foreground">~/.specrails/desktop.sqlite</span>
                </div>
              </SettingsCard>
            </div>
          </div>{/* /section content */}
        </div>
        <ConfirmDialog
          open={pendingRemoveProject !== null}
          onOpenChange={(next) => { if (!next) setPendingRemoveProject(null) }}
          title={t('desktop.removeProjectConfirmTitle', { name: pendingRemoveProject?.name ?? '' })}
          description={t('desktop.removeProjectConfirmBody', { name: pendingRemoveProject?.name ?? '' })}
          confirmLabel={t('common:actions.remove')}
          onConfirm={() => {
            const target = pendingRemoveProject
            setPendingRemoveProject(null)
            if (target) void handleRemoveProject(target.id)
          }}
        />
        <ConfirmDialog
          open={pendingDeleteWebhook !== null}
          onOpenChange={(next) => { if (!next) setPendingDeleteWebhook(null) }}
          title={t('webhooks.removeConfirmTitle')}
          description={t('webhooks.removeConfirmBody', { url: pendingDeleteWebhook?.url ?? '' })}
          confirmLabel={t('common:actions.remove')}
          onConfirm={() => {
            const target = pendingDeleteWebhook
            setPendingDeleteWebhook(null)
            if (target) void handleDeleteWebhook(target.id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
