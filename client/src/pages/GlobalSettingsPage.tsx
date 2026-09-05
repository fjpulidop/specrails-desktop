import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useTranslation, Trans } from 'react-i18next'
import { TerminalSettingsSection } from '../components/settings/TerminalSettingsSection'
import { EffectsSection } from '../components/settings/EffectsSection'
import { AppearanceSection } from '../components/settings/AppearanceSection'
import { LanguageSection } from '../components/settings/LanguageSection'
import { CodeSectionSettings } from '../components/settings/CodeSectionSettings'
import { SpecrailsAgentsSection } from '../components/settings/SpecrailsAgentsSection'
import { CoreUpdateSection } from '../components/settings/CoreUpdateSection'
import { AppUpdateSection } from '../components/settings/AppUpdateSection'
import { MobileAccessSection } from '../components/settings/MobileAccessSection'
import { McpSettingsSection } from '../components/settings/McpSettingsSection'
import { FEATURE_MCP } from '../lib/feature-flags'
import { Settings, Trash2, Zap, Plus, Bell, GraduationCap, Palette, Code2, RefreshCw, Smartphone, Bot, BrainCircuit, FolderOpen, SlidersHorizontal, Webhook, Info, TerminalSquare, Sparkles } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../components/ui/dialog'
import { useDesktop } from '../hooks/useDesktop'
import type { DesktopProject } from '../hooks/useDesktop'
import {
  getOsNotificationPrefs,
  setOsNotificationPrefs,
  type OsNotificationFilter,
} from '../hooks/useOsNotifications'

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
  open: boolean
  onClose: () => void
  onOpenOnboarding?: () => void
}

function ProjectListItem({
  project,
  onRemove,
}: {
  project: DesktopProject
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-md border border-border">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{project.name}</p>
        <p className="text-[10px] text-muted-foreground truncate">{project.path}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive shrink-0"
        onClick={() => onRemove(project.id)}
      >
        {t('common:actions.remove')}
      </Button>
    </div>
  )
}

// Left-nav sections for the two-pane settings layout. Each id matches a pane
// wrapper in the content area; contiguous settings blocks are grouped per tab.
const SETTINGS_SECTIONS = [
  { id: 'appearance', icon: Palette, labelKey: 'desktop.nav.appearance' },
  { id: 'effects', icon: Sparkles, labelKey: 'desktop.nav.effects' },
  { id: 'specrailsAgents', icon: BrainCircuit, labelKey: 'desktop.nav.specrailsAgents' },
  { id: 'code', icon: Code2, labelKey: 'desktop.nav.code' },
  { id: 'terminal', icon: TerminalSquare, labelKey: 'desktop.nav.terminal' },
  { id: 'updates', icon: RefreshCw, labelKey: 'desktop.nav.updates' },
  { id: 'mobile', icon: Smartphone, labelKey: 'desktop.nav.mobile' },
  { id: 'mcp', icon: Bot, labelKey: 'desktop.nav.mcp' },
  { id: 'projects', icon: FolderOpen, labelKey: 'desktop.nav.projects' },
  { id: 'advanced', icon: SlidersHorizontal, labelKey: 'desktop.nav.advanced' },
  { id: 'webhooks', icon: Webhook, labelKey: 'desktop.nav.webhooks' },
  { id: 'about', icon: Info, labelKey: 'desktop.nav.about' },
] as const

export default function SettingsDialog({ open, onClose, onOpenOnboarding }: SettingsDialogProps) {
  const { t } = useTranslation('settings')
  const { projects, removeProject } = useDesktop()
  const [activeSection, setActiveSection] = useState<string>('appearance')
  const paneCls = (id: string) => cn('space-y-5', activeSection === id ? '' : 'hidden')
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [costAlertThreshold, setCostAlertThreshold] = useState('')
  const [isSavingThreshold, setIsSavingThreshold] = useState(false)
  const [desktopDailyBudget, setDesktopDailyBudget] = useState('')
  const [isSavingDesktopBudget, setIsSavingDesktopBudget] = useState(false)

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
    setIsLoading(true)
    async function load() {
      try {
        const res = await fetch('/api/settings')
        if (res.ok) {
          const data = await res.json() as DesktopSettings
          setDesktopSettings(data)
          setCostAlertThreshold(data.costAlertThresholdUsd != null ? String(data.costAlertThresholdUsd) : '')
        }
      } catch {
        // ignore
      } finally {
        setIsLoading(false)
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
        if (data.desktopDailyBudgetUsd != null) setDesktopDailyBudget(String(data.desktopDailyBudgetUsd))
        else setDesktopDailyBudget('')
      })
      .catch(() => {})
  }, [open])

  async function handleSaveCostAlertThreshold() {
    setIsSavingThreshold(true)
    try {
      const parsed = costAlertThreshold.trim() === '' ? null : parseFloat(costAlertThreshold)
      if (parsed !== null && (isNaN(parsed) || parsed <= 0)) {
        toast.error(t('budget.invalidNumber'))
        return
      }
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costAlertThresholdUsd: parsed }),
      })
      if (res.ok) {
        toast.success(parsed == null ? t('desktop.costAlertsDisabled') : t('budget.alertSet', { amount: parsed }))
      } else {
        toast.error(t('budget.saveThresholdFailed'))
      }
    } catch {
      toast.error(t('budget.saveThresholdFailed'))
    } finally {
      setIsSavingThreshold(false)
    }
  }

  async function handleSaveDesktopDailyBudget() {
    setIsSavingDesktopBudget(true)
    try {
      const val = desktopDailyBudget.trim() === '' ? null : parseFloat(desktopDailyBudget)
      if (val !== null && (isNaN(val) || val <= 0)) {
        toast.error(t('budget.invalidNumber'))
        return
      }
      const res = await fetch('/api/budget', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktopDailyBudgetUsd: val }),
      })
      if (res.ok) {
        toast.success(val == null ? t('desktop.dailyBudgetRemoved') : t('desktop.dailyBudgetSet', { amount: val }))
      } else {
        toast.error(t('desktop.dailyBudgetSaveFailed'))
      }
    } catch {
      toast.error(t('desktop.dailyBudgetSaveFailed'))
    } finally {
      setIsSavingDesktopBudget(false)
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
      await fetch(`/api/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
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
            <Settings className="w-4 h-4" />
            {t('desktop.title')}
          </DialogTitle>
          <DialogDescription>
            {t('desktop.description')}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-2">
            <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
            <div className="h-16 bg-muted/30 rounded-lg animate-pulse" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-5 py-2">
            {/* Left section nav */}
            <nav className="w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border pr-2">
              {SETTINGS_SECTIONS.map((s) => {
                if (s.id === 'mcp' && !FEATURE_MCP) return null
                const Icon = s.icon
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setActiveSection(s.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                      activeSection === s.id
                        ? 'bg-accent-primary/15 font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{t(s.labelKey)}</span>
                  </button>
                )
              })}
            </nav>

            {/* Active section content — fills the fixed-height dialog and scrolls,
                so switching sections never resizes the modal. */}
            <div className="min-w-0 flex-1 overflow-y-auto pr-1">
            <div className={paneCls('appearance')}>
            <AppearanceSection />

            <LanguageSection />
            </div>

            <div className={paneCls('effects')}>
            <EffectsSection />
            </div>

            <div className={paneCls('specrailsAgents')}>
            <SpecrailsAgentsSection />
            </div>

            <div className={paneCls('code')}>
            <CodeSectionSettings />
            </div>

            <div className={paneCls('updates')}>
            <AppUpdateSection />

            <CoreUpdateSection />
            </div>

            <div className={paneCls('mobile')}>
            <MobileAccessSection />
            </div>

            {FEATURE_MCP && <div className={paneCls('mcp')}><McpSettingsSection /></div>}

            {/* Projects section */}
            <div className={paneCls('projects')}>
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t('desktop.registeredProjects')}
              </h3>
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
                      onRemove={handleRemoveProject}
                    />
                  ))}
                </div>
              )}
            </div>

            </div>

            <div className={paneCls('advanced')}>
            {/* Budget & Alerts */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t('desktop.budgetAlertsHeading')}
              </h3>
              <div className="rounded-md border border-border p-3 space-y-4">
                {/* Desktop daily budget */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">{t('desktop.dailyBudgetLabel')}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {t('desktop.dailyBudgetHelper')}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={desktopDailyBudget}
                      onChange={(e) => setDesktopDailyBudget(e.target.value)}
                      placeholder={t('desktop.dailyBudgetPlaceholder')}
                      className="h-7 text-xs font-mono"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs shrink-0"
                      disabled={isSavingDesktopBudget}
                      onClick={() => void handleSaveDesktopDailyBudget()}
                    >
                      {t('common:actions.save')}
                    </Button>
                  </div>
                </div>

                {/* Per-job cost alert threshold */}
                <div className="space-y-1.5 border-t border-border pt-3">
                  <p className="text-xs font-medium">{t('budget.perJobLabel')}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {t('desktop.perJobHelper')}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={costAlertThreshold}
                      onChange={(e) => setCostAlertThreshold(e.target.value)}
                      placeholder={t('budget.perJobPlaceholder')}
                      className="h-7 text-xs font-mono"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs shrink-0"
                      disabled={isSavingThreshold}
                      onClick={handleSaveCostAlertThreshold}
                    >
                      {t('common:actions.save')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {/* OS Notifications */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t('notifications.heading')}
              </h3>
              <div className="rounded-md border border-border p-3 space-y-3">
                <p className="text-[10px] text-muted-foreground">
                  {t('notifications.description')}
                </p>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifEnabled}
                    onChange={(e) => handleToggleNotifications(e.target.checked)}
                    className="w-3.5 h-3.5"
                    data-testid="notif-toggle"
                  />
                  <Bell className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs">{t('notifications.enableLabel')}</span>
                </label>
                {notifEnabled && (
                  <div className="space-y-1.5 pl-6">
                    <p className="text-[10px] text-muted-foreground">{t('notifications.notifyOn')}</p>
                    <div className="flex flex-wrap gap-3">
                      {([
                        { value: 'all' as const, label: t('notifications.filterAll') },
                        { value: 'completed' as const, label: t('notifications.filterCompleted') },
                        { value: 'failed' as const, label: t('notifications.filterFailed') },
                      ]).map(({ value, label }) => (
                        <label key={value} className="flex items-center gap-1.5 text-[10px] cursor-pointer">
                          <input
                            type="radio"
                            name="notif-filter"
                            checked={notifFilter === value}
                            onChange={() => handleNotifFilterChange(value)}
                            className="w-3 h-3"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            </div>

            <div className={paneCls('webhooks')}>
            {/* Webhooks */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t('webhooks.heading')}
              </h3>
              <div className="rounded-md border border-border p-3 space-y-3">
                <p className="text-[10px] text-muted-foreground">
                  <Trans
                    ns="settings"
                    i18nKey="webhooks.description"
                    components={{ code: <code className="font-mono" /> }}
                  />
                </p>

                {webhooks.length > 0 && (
                  <div className="space-y-1.5">
                    {webhooks.map((wh) => {
                      const events: string[] = (() => { try { return JSON.parse(wh.events) as string[] } catch { return [] } })()
                      return (
                        <div key={wh.id} className="flex items-start gap-2 rounded-md border border-border p-2">
                          <div className="flex-1 min-w-0 space-y-0.5">
                            <p className="text-xs font-mono truncate">{wh.url}</p>
                            <p className="text-[10px] text-muted-foreground">{events.join(', ')}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => void handleToggleWebhook(wh.id, !wh.enabled)}
                              className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${wh.enabled ? 'bg-green-500/10 aurora-light:bg-accent-success/10 text-green-600 aurora-light:text-accent-success dark:text-green-400' : 'bg-muted text-muted-foreground'}`}
                              title={wh.enabled ? t('webhooks.disable') : t('webhooks.enable')}
                            >
                              {wh.enabled ? t('webhooks.statusOn') : t('webhooks.statusOff')}
                            </button>
                            <button
                              onClick={() => void handleTestWebhook(wh.id)}
                              className="text-muted-foreground hover:text-foreground p-0.5"
                              title={t('webhooks.sendTestPing')}
                            >
                              <Zap className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => void handleDeleteWebhook(wh.id)}
                              className="text-muted-foreground hover:text-destructive p-0.5"
                              title={t('common:actions.remove')}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="space-y-2 border-t border-border pt-2">
                  <p className="text-[10px] font-medium text-muted-foreground">{t('webhooks.addHeading')}</p>
                  <Input
                    value={newWebhookUrl}
                    onChange={(e) => setNewWebhookUrl(e.target.value)}
                    placeholder="https://hooks.example.com/..."
                    className="h-7 text-xs font-mono"
                  />
                  <Input
                    value={newWebhookSecret}
                    onChange={(e) => setNewWebhookSecret(e.target.value)}
                    placeholder={t('webhooks.secretPlaceholder')}
                    className="h-7 text-xs font-mono"
                  />
                  <div className="flex flex-wrap gap-3">
                    {WEBHOOK_EVENTS.map(({ value, labelKey }) => (
                      <label key={value} className="flex items-center gap-1.5 text-[10px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newWebhookEvents.includes(value)}
                          onChange={() => toggleNewEvent(value)}
                          className="w-3 h-3"
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
                    <Plus className="w-3 h-3 mr-1" />
                    {t('webhooks.addButton')}
                  </Button>
                </div>
              </div>
            </div>

            </div>

            <div className={paneCls('about')}>
            {/* Onboarding */}
            {onOpenOnboarding && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('desktop.onboardingHeading')}
                </h3>
                <div className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium">{t('desktop.platformTour')}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {t('desktop.platformTourDescription')}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs shrink-0"
                      onClick={onOpenOnboarding}
                      data-testid="replay-onboarding"
                    >
                      <GraduationCap className="w-3 h-3 mr-1" />
                      {t('desktop.replayTour')}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            </div>

            <div className={paneCls('terminal')}>
            {/* Terminal panel */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t('desktop.terminalPanelHeading')}
              </h3>
              <TerminalSettingsSection mode="desktop" />
            </div>
            </div>

            <div className={paneCls('about')}>
            {/* Desktop info */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t('desktop.infoHeading')}
              </h3>
              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('desktop.infoPort')}</span>
                  <span className="font-mono">{desktopSettings?.port ?? 4200}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('desktop.infoProjects')}</span>
                  <span className="font-mono">{projects.length}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('desktop.infoDb')}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">~/.specrails/desktop.sqlite</span>
                </div>
              </div>
            </div>
            </div>{/* /pane about */}
            </div>{/* /section content */}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
