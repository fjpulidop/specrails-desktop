import { useEffect, useState, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../lib/api'
import { useDesktop } from '../hooks/useDesktop'
import type { ProjectConfig } from '../types'
import { TerminalSettingsSection } from '../components/settings/TerminalSettingsSection'
import {
  ProjectTelemetrySection,
  ProjectPrePromptsSection,
  ProjectBudgetSection,
  ProjectIntegrationBranchSection,
  ProjectWorktreeEnvSection,
} from '../components/settings/ProjectSettingsSections'

export default function SettingsPage() {
  const { t } = useTranslation('settings')
  const { activeProjectId } = useDesktop()
  const location = useLocation()
  // SettingsPage is only mounted in Super mode; telemetry toggle is Super-mode-only
  const isSuperMode = activeProjectId !== null

  // Scroll-to-hash + brief highlight when the page is opened with a hash anchor
  // (e.g. /settings#terminal-browser-shortcut-url from the topbar context menu).
  // The TerminalSettingsSection mounts in a loading state and only renders the
  // anchored field after its fetch resolves, so we poll for the element with a
  // 3s budget instead of trying once.
  useEffect(() => {
    if (!location.hash) return
    const id = location.hash.slice(1)
    let cancelled = false
    const deadline = Date.now() + 3000
    const tryScroll = (): void => {
      if (cancelled) return
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('ring-2', 'ring-accent-primary/60', 'rounded')
        window.setTimeout(() => {
          el.classList.remove('ring-2', 'ring-accent-primary/60', 'rounded')
        }, 1800)
        return
      }
      if (Date.now() < deadline) {
        window.setTimeout(tryScroll, 80)
      }
    }
    tryScroll()
    return () => { cancelled = true }
  }, [location.hash, location.key])

  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const cacheRef = useRef<Map<string, ProjectConfig>>(new Map())

  useEffect(() => {
    // Restore cache instantly on project switch
    if (activeProjectId) {
      const cached = cacheRef.current.get(activeProjectId)
      if (cached) {
        setConfig(cached)
        setIsLoading(false)
      } else {
        setIsLoading(true)
      }
    }
    async function loadConfig() {
      try {
        const res = await fetch(`${getApiBase()}/config`)
        if (!res.ok) return
        const data = await res.json() as ProjectConfig
        setConfig(data)
        if (activeProjectId) cacheRef.current.set(activeProjectId, data)
      } catch {
        // ignore
      } finally {
        setIsLoading(false)
      }
    }
    loadConfig()
  }, [activeProjectId])

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 bg-muted/30 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-base font-semibold">{t('page.title')}</h1>
        {config && (
          <p className="text-xs text-muted-foreground mt-1">
            {config.project.name}
            {config.project.repo && ` · ${config.project.repo}`}
          </p>
        )}
      </div>

      {/* Pipeline Telemetry Section — Super mode only */}
      {isSuperMode && <ProjectTelemetrySection />}

      <ProjectPrePromptsSection />

      <ProjectIntegrationBranchSection />

      <ProjectWorktreeEnvSection />

      <ProjectBudgetSection />

      <TerminalSettingsSection mode="project" />

    </div>
  )
}
