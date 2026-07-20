import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, Briefcase, BarChart3, Bot, Code2, Settings, PanelRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { useSidebarPin } from '../context/SidebarPinContext'
import { useDesktop, projectProviders } from '../hooks/useDesktop'
import { FEATURE_AGENTS_SECTION, FEATURE_CODE_EXPLORER } from '../lib/feature-flags'
import { sectionVisibleForProviders } from '../lib/provider-capabilities'
import { BuilderSidebarEntry } from './project-builder/BuilderSidebarEntry'

const RIGHT_PIN_LABEL_KEY: Record<'pinned-open' | 'pinned-collapsed' | 'unpinned', string> = {
  'pinned-open': 'sidebarPin.right.pinnedOpen',
  'pinned-collapsed': 'sidebarPin.right.pinnedCollapsed',
  'unpinned': 'sidebarPin.right.unpinned',
}

export function ProjectRightSidebar() {
  const { t } = useTranslation('nav')
  const { rightMode, cycleRightMode } = useSidebarPin()
  const { projects, activeProjectId } = useDesktop()
  const [hovered, setHovered] = useState(false)
  const expanded = rightMode === 'pinned-open' || (rightMode === 'unpinned' && hovered)
  const lit = rightMode !== 'unpinned'
  const pinLabel = t(RIGHT_PIN_LABEL_KEY[rightMode])

  // Provider-sensitive sections use the capability intersection across every
  // installed engine. Profiles are currently supported by Claude and Kimi;
  // a mixed project that also includes an unsupported engine hides Agents.
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const providers = activeProject ? projectProviders(activeProject) : ['claude']
  const showAgentsTab = FEATURE_AGENTS_SECTION && sectionVisibleForProviders('agents', providers)

  const navItems = [
    { to: '/', end: true, icon: LayoutDashboard, label: t('rightSidebar.dashboard') },
    { to: '/jobs', end: false, icon: Briefcase, label: t('rightSidebar.jobs') },
    { to: '/analytics', end: false, icon: BarChart3, label: t('rightSidebar.analytics') },
    ...(showAgentsTab
      ? [{ to: '/agents', end: false, icon: Bot, label: t('rightSidebar.agents') }]
      : []),
    ...(FEATURE_CODE_EXPLORER
      ? [{ to: '/code', end: false, icon: Code2, label: t('rightSidebar.code') }]
      : []),
    { to: '/settings', end: false, icon: Settings, label: t('rightSidebar.settings') },
  ]

  return (
    <div
      className={cn(
        'relative flex flex-col h-full border-l border-border bg-background flex-shrink-0',
        'transition-all duration-200 ease-in-out overflow-hidden',
        expanded ? 'w-44' : 'w-11'
      )}
      onMouseEnter={() => { if (rightMode === 'unpinned') setHovered(true) }}
      onMouseLeave={() => { if (rightMode === 'unpinned') setHovered(false) }}
    >
      {/* Header */}
      <div className={cn(
        'flex items-center h-12 border-b border-border flex-shrink-0',
        expanded ? 'px-3 justify-between' : 'justify-center'
      )}>
        {expanded && (
          <span className="font-mono text-sm font-bold whitespace-nowrap overflow-hidden text-accent-secondary">
            {t('rightSidebar.projectTitle')}
          </span>
        )}
        <button
          type="button"
          onClick={cycleRightMode}
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-md transition-colors',
            lit
              ? 'text-foreground bg-muted'
              : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'
          )}
          aria-label={pinLabel}
          title={t('sidebarPin.withShortcut', { label: pinLabel, shortcut: '⌘B' })}
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-2 px-1.5 space-y-0.5">
        <BuilderSidebarEntry expanded={expanded} />
        {navItems.map(({ to, end, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => cn(
              'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
              expanded ? 'px-2' : 'px-0 justify-center',
              isActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
            title={!expanded ? label : undefined}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {expanded && <span className="text-xs truncate">{label}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
