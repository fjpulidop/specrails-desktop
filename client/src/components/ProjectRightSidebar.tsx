import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, Briefcase, BarChart3, Code2, Settings } from 'lucide-react'
import { openProjectSettings } from '../lib/app-settings-events'
import { cn } from '../lib/utils'
import { useSidebarPin } from '../context/SidebarPinContext'
import { useResizableSidebar } from '../hooks/useResizableSidebar'
import { useSidebarHoverIntent } from '../hooks/useSidebarHoverIntent'
import { SidebarResizeGrip } from './SidebarResizeGrip'
import { FEATURE_CODE_EXPLORER } from '../lib/feature-flags'
import { BuilderSidebarEntry } from '../features/builder/components/project-builder/BuilderSidebarEntry'

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2'

export function ProjectRightSidebar() {
  const { t } = useTranslation('nav')
  const { effectiveRightMode } = useSidebarPin()
  const unpinned = effectiveRightMode === 'unpinned'
  const docked = effectiveRightMode === 'pinned-open'
  const [dragging, setDragging] = useState(false)
  const hover = useSidebarHoverIntent({ enabled: unpinned, dragging })
  const expanded = docked || (unpinned && hover.hovered)
  // Same chrome as the Agent-Mode workspace rail: drag-resizable (208px default),
  // fully hidden when collapsed; a hover-expanded unpinned rail overlays the content.
  const resize = useResizableSidebar('right-project', {
    side: 'right', defaultWidth: 208, min: 180, max: 460, collapsedWidth: 0, expanded, docked,
  })
  useEffect(() => { setDragging(resize.dragging) }, [resize.dragging])
  const overlaying = expanded && !docked

  // Agents is intentionally HIDDEN in board mode (user decision 2026-07-22) —
  // profiles/catalog remain reachable via the /agents route and Agent Mode
  // surfaces; the board sidebar stays focused on the delivery flow.

  const navItems = [
    { to: '/', end: true, icon: LayoutDashboard, label: t('rightSidebar.dashboard') },
    { to: '/jobs', end: false, icon: Briefcase, label: t('rightSidebar.jobs') },
    { to: '/analytics', end: false, icon: BarChart3, label: t('rightSidebar.analytics') },
    ...(FEATURE_CODE_EXPLORER
      ? [{ to: '/code', end: false, icon: Code2, label: t('rightSidebar.code') }]
      : []),
  ]

  return (
    <aside
      ref={resize.wrapperRef}
      tabIndex={unpinned && !expanded ? 0 : -1}
      aria-label={t('rightSidebar.landmark')}
      className="relative h-full flex-shrink-0 transition-[width] duration-200 ease-in-out"
      {...hover.handlers}
    >
    {unpinned && !expanded && <div aria-hidden="true" data-testid="sidebar-edge-right" className="absolute inset-y-0 right-0 z-30 w-2" />}
    <div
      ref={resize.panelRef}
      inert={!expanded}
      aria-hidden={!expanded}
      data-testid="project-right-sidebar-panel"
      data-overlay={overlaying || undefined}
      className={cn(
        'absolute inset-y-0 right-0 z-30 flex flex-col border-l border-border surface-side overflow-hidden',
        'transition-[width,box-shadow] duration-200 ease-in-out',
        !expanded && 'invisible border-none',
        overlaying && 'shadow-xl',
      )}
    >
      {expanded && (
        <SidebarResizeGrip
          side="right"
          dragging={resize.dragging}
          width={resize.width}
          min={180}
          max={460}
          label={t('sidebarPin.resize')}
          onPointerDown={resize.onGripPointerDown}
          onKeyDown={resize.onGripKeyDown}
        />
      )}

      {/* Nav items */}
      <nav aria-label={t('rightSidebar.projectTitle')} className="flex-1 py-2 px-1.5 space-y-0.5">
        <BuilderSidebarEntry expanded={expanded} />
        {navItems.map(({ to, end, icon: Icon, label }) => (
          <NavLink
            key={to}
            data-area={to === '/' ? 'specs' : to === '/code' ? 'files' : to.slice(1)}
            to={to}
            end={end}
            // A floating (unpinned) rail gets out of the way of the page it
            // just opened; a docked rail stays.
            onClick={() => { if (overlaying) hover.dismiss() }}
            className={({ isActive }) => cn(
              'area-nav flex items-center gap-2 w-full h-8 rounded-md transition-colors',
              expanded ? 'px-2' : 'px-0 justify-center',
              isActive
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              FOCUS_RING,
            )}
            title={!expanded ? label : undefined}
            aria-label={!expanded ? label : undefined}
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('w-4 h-4 flex-shrink-0', isActive && 'text-accent-primary')} aria-hidden />
                {expanded && <span className="text-xs truncate">{label}</span>}
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          data-area="settings"
          aria-label={t('rightSidebar.settings')}
          onClick={() => { if (overlaying) hover.dismiss(); openProjectSettings() }}
          className={cn('area-nav flex h-8 w-full items-center gap-2 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            expanded ? 'px-2' : 'justify-center', FOCUS_RING)}
        >
          <Settings className="h-4 w-4 shrink-0" aria-hidden />
          {expanded && <span className="truncate text-xs">{t('rightSidebar.settings')}</span>}
        </button>
      </nav>
    </div>
    </aside>
  )
}
