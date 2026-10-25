import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'
import { useDesktop } from '../../../hooks/useDesktop'
import type { ProjectConfig } from '../../../types'
import { PROJECT_SETTINGS_SECTIONS, ProjectSettingsPane } from '../components/project-settings-sections'
import { SETTING_PARAM, focusSettingAnchor } from '../lib/setting-anchor'
import { ProjectTelemetrySection } from '../components/ProjectSettingsSections'
import { notifyError } from '../../../lib/notify-error'
import { cn } from '../../../lib/utils'

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

  // ⌘K `/` in Board mode: /settings?setting=<id> lands on that block once it has mounted.
  const settingId = new URLSearchParams(location.search).get(SETTING_PARAM)
  useEffect(() => {
    if (!settingId) return
    return focusSettingAnchor(settingId)
  }, [settingId, location.key])

  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const cacheRef = useRef<Map<string, ProjectConfig>>(new Map())

  const loadConfig = useCallback(async (projectId: string | null) => {
    try {
      const res = await fetch(`${getApiBase()}/config`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as ProjectConfig
      setConfig(data)
      if (projectId) cacheRef.current.set(projectId, data)
    } catch (err) {
      // The panes load themselves, so the page stays usable; only the header detail is missing.
      notifyError(t('page.loadFailed'), {
        detail: err instanceof Error ? err.message : undefined,
        retry: () => { void loadConfig(projectId) },
        id: 'project-settings-config',
      })
    } finally {
      setIsLoading(false)
    }
  }, [t])

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
    void loadConfig(activeProjectId)
  }, [activeProjectId, loadConfig])

  // Sections that render at least one pane (telemetry is Super-mode only).
  const sections = useMemo(() => PROJECT_SETTINGS_SECTIONS
    .map((section) => ({ ...section, panes: section.panes.filter((Pane) => isSuperMode || Pane !== ProjectTelemetrySection) }))
    .filter((section) => section.panes.length > 0), [isSuperMode])

  const [currentSection, setCurrentSection] = useState<string>(sections[0]?.id ?? 'general')
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map())

  // Scroll-spy: the section whose top has crossed the upper third of the viewport is current.
  useEffect(() => {
    if (isLoading || typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.sectionId
        if (!id) continue
        if (entry.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      const first = sections.find((s) => visible.has(s.id))
      if (first) setCurrentSection(first.id)
    }, { rootMargin: '0px 0px -66% 0px' })
    sectionEls.current.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [isLoading, sections])

  const goToSection = useCallback((id: string) => {
    setCurrentSection(id)
    sectionEls.current.get(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [])

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 bg-muted/30 rounded-lg motion-safe:animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-6">
        <h1 className="text-headline">{t('page.title')}</h1>
        {config && (
          <p className="text-caption text-muted-foreground mt-1">
            {config.project.name}
            {config.project.repo && ` · ${config.project.repo}`}
          </p>
        )}
      </div>

      <div className="flex items-start gap-8">
        {/* Section index: sticky side nav from 900px, a select below it. */}
        <nav aria-label={t('projectDialog.navLabel')} className="hidden min-[900px]:block sticky top-6 w-44 shrink-0 self-start">
          <ul className="space-y-0.5">
            {sections.map((section) => {
              const Icon = section.icon
              const active = currentSection === section.id
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => goToSection(section.id)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-accent-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t(section.labelKey)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 max-w-2xl space-y-6">
          <select
            aria-label={t('projectDialog.navLabel')}
            value={currentSection}
            onChange={(e) => goToSection(e.target.value)}
            className="min-[900px]:hidden w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sections.map((section) => <option key={section.id} value={section.id}>{t(section.labelKey)}</option>)}
          </select>

          {sections.map((section) => (
            <section
              key={section.id}
              id={`settings-section-${section.id}`}
              data-section-id={section.id}
              aria-label={t(section.labelKey)}
              ref={(el) => { if (el) sectionEls.current.set(section.id, el); else sectionEls.current.delete(section.id) }}
              className="scroll-mt-6 space-y-6"
            >
              {section.panes.map((Pane, i) => <ProjectSettingsPane key={`${section.id}-${i}`} Pane={Pane} />)}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
