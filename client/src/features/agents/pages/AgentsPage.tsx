import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { ProfilesTab } from '../components/ProfilesTab'
import { AgentsCatalogTab } from '../components/AgentsCatalogTab'
import { ProfileAnalyticsCard } from '../components/ProfileAnalyticsCard'
import { useMinimizedChats } from '../../missions/context/MinimizedChatsContext'
import { useDesktop } from '../../../hooks/useDesktop'
import { openAppSettings } from '../../../lib/app-settings-events'

type Tab = 'profiles' | 'usage' | 'catalog'
const TABS: readonly Tab[] = ['profiles', 'usage', 'catalog']

interface CoreVersionStatus {
  version: string | null
  required: string
  profileAware: boolean
}

const TAB_MEMORY_KEY = 'specrails-desktop:agents-tab'

function readTabMemory(): Tab {
  try {
    const v = localStorage.getItem(TAB_MEMORY_KEY)
    if (v === 'profiles' || v === 'usage' || v === 'catalog') return v
  } catch {
    // localStorage unavailable
  }
  return 'profiles'
}

export default function AgentsPage() {
  const { t } = useTranslation('agents')
  const [tab, setTabState] = useState<Tab>(() => readTabMemory())
  const setTab = (next: Tab) => {
    setTabState(next)
    try { localStorage.setItem(TAB_MEMORY_KEY, next) } catch { /* ignore */ }
  }
  const [coreStatus, setCoreStatus] = useState<CoreVersionStatus | null>(null)
  const { activeProjectId } = useDesktop()
  const { pendingRestores } = useMinimizedChats()

  // The ai-edit restore trigger (usePendingRestore) lives inside
  // AgentsCatalogTab, which only mounts on the 'catalog' tab. When an AI-Edit
  // chip is restored while this page is on another tab, force the Catalog tab
  // once so the trigger mounts and consumes the pending restore. EDGE-triggered
  // (only on the rising edge of "a pending ai-edit appeared") so it never
  // fights the user manually leaving the tab afterwards.
  const hadAiEditPendingRef = useRef(false)
  useEffect(() => {
    if (!activeProjectId) return
    const hasAiEditPending = pendingRestores.some(
      (c) => c.kind === 'ai-edit' && c.projectId === activeProjectId,
    )
    if (hasAiEditPending && !hadAiEditPendingRef.current && tab !== 'catalog') {
      setTab('catalog')
    }
    hadAiEditPendingRef.current = hasAiEditPending
    // setTab is stable enough for this purpose; only react to queue/project/tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRestores, activeProjectId, tab])

  useEffect(() => {
    let cancelled = false
    fetch(`${getApiBase()}/profiles/core-version`)
      .then((r) => (r.ok ? (r.json() as Promise<CoreVersionStatus>) : null))
      .then((data) => {
        if (!cancelled && data) setCoreStatus(data)
      })
      .catch(() => {
        // ignore — banner simply won't show
      })
    return () => {
      cancelled = true
    }
  }, [])

  const showUpgradeBanner = coreStatus !== null && !coreStatus.profileAware

  return (
    <div className="flex flex-col h-full">
      {showUpgradeBanner && (
        <div className="flex-shrink-0 flex items-start gap-3 px-6 py-3 border-b border-accent-warning/30 bg-accent-warning/10">
          <AlertTriangle className="w-4 h-4 text-accent-warning mt-0.5 flex-shrink-0" aria-hidden />
          <div className="text-xs">
            <div className="font-medium text-accent-warning">
              {t('page.banner.title', { required: coreStatus!.required })}
            </div>
            <div className="text-foreground mt-0.5">
              <Trans
                t={t}
                i18nKey="page.banner.body"
                values={{
                  version: coreStatus!.version ?? t('page.banner.unknownVersion'),
                }}
                components={{ code: <code className="px-1 rounded bg-accent-warning/20" /> }}
              />
            </div>
            <button
              type="button"
              onClick={() => openAppSettings('updates')}
              className="mt-1.5 rounded-sm font-medium text-accent-warning underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('page.banner.openUpdates')}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex-shrink-0 border-b border-border">
        <div className="px-6 pt-4">
          <h1 className="text-lg font-semibold">{t('page.title')}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('page.subtitle')}
          </p>
        </div>
        <div
          role="tablist"
          aria-label={t('page.title')}
          className="flex items-center gap-1 px-4 pt-3"
          onKeyDown={(e) => {
            const idx = TABS.indexOf(tab)
            let next: Tab | null = null
            if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length]
            else if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length]
            else if (e.key === 'Home') next = TABS[0]
            else if (e.key === 'End') next = TABS[TABS.length - 1]
            if (!next) return
            e.preventDefault()
            setTab(next)
            document.getElementById(`agents-tab-${next}`)?.focus()
          }}
        >
          {TABS.map((id) => (
            <TabButton key={id} id={id} active={tab === id} onClick={() => setTab(id)}>
              {t(`page.tabs.${id}`)}
            </TabButton>
          ))}
        </div>
      </div>

      {/* Body */}
      <div
        role="tabpanel"
        id={`agents-tabpanel-${tab}`}
        aria-labelledby={`agents-tab-${tab}`}
        className="flex-1 min-w-0 overflow-auto"
      >
        {tab === 'profiles' && <ProfilesTab />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'catalog' && <AgentsCatalogTab />}
      </div>
    </div>
  )
}

function UsageTab() {
  return (
    <div className="min-h-full">
      <ProfileAnalyticsCard />
    </div>
  )
}

function TabButton({
  id,
  active,
  children,
  onClick,
}: {
  id: Tab
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`agents-tab-${id}`}
      aria-selected={active}
      aria-controls={`agents-tabpanel-${id}`}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={
        'h-8 px-3 text-label border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
        (active
          ? 'text-foreground border-foreground'
          : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border')
      }
    >
      {children}
    </button>
  )
}
