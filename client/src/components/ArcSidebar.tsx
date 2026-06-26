import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PanelLeft, FolderOpen, Plus, BarChart2, BookOpen, Settings, X, Workflow } from 'lucide-react'
import { cn } from '../lib/utils'
import { useDesktop } from '../hooks/useDesktop'
import type { DesktopProject } from '../hooks/useDesktop'
import { useSidebarPin } from '../context/SidebarPinContext'
import { FEATURE_LOOPS_SECTION } from '../lib/feature-flags'

interface ArcSidebarProps {
  onAddProject: () => void
  onOpenLoops: () => void
  onOpenAnalytics: () => void
  onOpenDocs: () => void
  onOpenSettings: () => void
}

function ProjectItem({
  project,
  isActive,
  expanded,
  onSelect,
  onRemove,
}: {
  project: DesktopProject
  isActive: boolean
  expanded: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('nav')
  const [confirming, setConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  function handleRemoveClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (confirming) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirming(false)
      onRemove()
    } else {
      setConfirming(true)
      confirmTimerRef.current = setTimeout(() => {
        setConfirming(false)
        confirmTimerRef.current = null
      }, 3000)
    }
  }

  function handleSelectKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onSelect()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleSelectKeyDown}
      className={cn(
        'group relative flex items-center gap-2 w-full h-8 rounded-md transition-colors',
        expanded ? 'px-2' : 'px-0 justify-center',
        isActive
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
      )}
      title={!expanded ? project.name : undefined}
      aria-current={isActive ? 'page' : undefined}
    >
      <FolderOpen
        className={cn(
          'flex-shrink-0 w-4 h-4',
          isActive && 'text-accent-primary'
        )}
      />
      {expanded && (
        <>
          <span className="text-xs truncate flex-1 text-left">{project.name}</span>
          <button
            type="button"
            onClick={handleRemoveClick}
            className={cn(
              'flex-shrink-0 flex items-center justify-center rounded-sm transition-all',
              'opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-muted',
              confirming
                ? 'opacity-100 px-1 h-4 text-[10px] text-destructive bg-destructive/10 hover:bg-destructive/20'
                : 'w-3.5 h-3.5'
            )}
            aria-label={confirming ? t('projects.confirmRemove', { name: project.name }) : t('projects.remove', { name: project.name })}
          >
            {confirming ? t('projects.confirmShort') : <X className="w-2.5 h-2.5" />}
          </button>
        </>
      )}
    </div>
  )
}

const LEFT_PIN_LABEL_KEY: Record<'pinned-open' | 'pinned-collapsed' | 'unpinned', string> = {
  'pinned-open': 'sidebarPin.left.pinnedOpen',
  'pinned-collapsed': 'sidebarPin.left.pinnedCollapsed',
  'unpinned': 'sidebarPin.left.unpinned',
}

export function ArcSidebar({
  onAddProject,
  onOpenLoops,
  onOpenAnalytics,
  onOpenDocs,
  onOpenSettings,
}: ArcSidebarProps) {
  const { t } = useTranslation('nav')
  const { projects, activeProjectId, setActiveProjectId, removeProject } = useDesktop()
  const navigate = useNavigate()
  const location = useLocation()
  const onLoopsRoute = location.pathname.startsWith('/loops')
  const { leftMode, cycleLeftMode } = useSidebarPin()

  // Selecting a project from the sidebar. When the user is on a GLOBAL route
  // (/loops, /docs) and taps a project, switching activeProjectId alone doesn't
  // leave the global page — and tapping the ALREADY-active project is a no-op
  // (no state change → the route-memory effect never fires). So when on a global
  // route, navigate the active project back to its dashboard explicitly; a
  // different project still goes through setActiveProjectId (the route-memory
  // effect restores its last surface).
  function handleSelectProject(projectId: string) {
    if (projectId === activeProjectId) {
      // Already active: only meaningful when viewing a global page — return to
      // the project's dashboard (no state change would fire the route effect).
      if (location.pathname.startsWith('/loops') || location.pathname.startsWith('/docs')) {
        navigate('/')
      }
      return
    }
    // Different project: switching activeProjectId fires the route-memory effect,
    // which navigates to that project's last surface (off any global route).
    setActiveProjectId(projectId)
  }
  const [hovered, setHovered] = useState(false)
  const expanded = leftMode === 'pinned-open' || (leftMode === 'unpinned' && hovered)
  const lit = leftMode !== 'unpinned'
  const pinLabel = t(LEFT_PIN_LABEL_KEY[leftMode])

  const navItems = [
    { label: t('arcSidebar.docs'), icon: BookOpen, action: onOpenDocs },
    { label: t('arcSidebar.analytics'), icon: BarChart2, action: onOpenAnalytics },
    { label: t('arcSidebar.settings'), icon: Settings, action: onOpenSettings },
  ]

  async function handleRemove(project: DesktopProject) {
    try {
      await removeProject(project.id)
    } catch {
      // errors handled via toast in parent
    }
  }

  return (
    <div
      className={cn(
        'relative flex flex-col h-full border-r border-border bg-background flex-shrink-0',
        'transition-all duration-200 ease-in-out overflow-hidden',
        expanded ? 'w-52' : 'w-11'
      )}
      onMouseEnter={() => { if (leftMode === 'unpinned') setHovered(true) }}
      onMouseLeave={() => { if (leftMode === 'unpinned') setHovered(false) }}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center h-12 border-b border-border flex-shrink-0',
          expanded ? 'px-3 justify-between' : 'justify-center'
        )}
      >
        {expanded && (
          <span className="font-mono text-sm font-bold whitespace-nowrap overflow-hidden text-accent-primary">
            {t('arcSidebar.desktopTitle')}
          </span>
        )}
        <button
          type="button"
          onClick={cycleLeftMode}
          className={cn(
            'flex items-center justify-center w-7 h-7 rounded-md transition-colors flex-shrink-0',
            lit
              ? 'text-foreground bg-muted'
              : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'
          )}
          aria-label={pinLabel}
          title={t('sidebarPin.withShortcut', { label: pinLabel, shortcut: '⌥⌘B' })}
        >
          <PanelLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Loops — global section, above the project list with a separator below */}
      {FEATURE_LOOPS_SECTION && (
        <>
          <div className="py-2 px-1.5">
            <button
              type="button"
              onClick={onOpenLoops}
              className={cn(
                'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
                expanded ? 'px-2' : 'px-0 justify-center',
                onLoopsRoute
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              aria-label={t('arcSidebar.loops')}
              aria-current={onLoopsRoute ? 'page' : undefined}
              title={!expanded ? t('arcSidebar.loops') : undefined}
            >
              <Workflow className={cn('w-4 h-4 flex-shrink-0', onLoopsRoute && 'text-accent-primary')} />
              {expanded && <span className="text-xs whitespace-nowrap">{t('arcSidebar.loops')}</span>}
            </button>
          </div>
          <div className="border-t border-border" aria-hidden />
        </>
      )}

      {/* Projects list */}
      <div className="flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5">
        {projects.map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            isActive={project.id === activeProjectId && !onLoopsRoute}
            expanded={expanded}
            onSelect={() => handleSelectProject(project.id)}
            onRemove={() => handleRemove(project)}
          />
        ))}

        {/* Add project */}
        <button
          type="button"
          onClick={onAddProject}
          className={cn(
            'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            expanded ? 'px-2' : 'px-0 justify-center'
          )}
          aria-label={t('projects.addProject')}
          title={!expanded ? t('projects.addProject') : undefined}
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          {expanded && <span className="text-xs whitespace-nowrap">{t('projects.addProject')}</span>}
        </button>
      </div>

      {/* Desktop nav items */}
      <div className="border-t border-border py-2 px-1.5 space-y-0.5">
        {navItems.map(({ label, icon: Icon, action }) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className={cn(
              'flex items-center gap-2 w-full h-8 rounded-md transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              expanded ? 'px-2' : 'px-0 justify-center'
            )}
            aria-label={label}
            title={!expanded ? label : undefined}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {expanded && <span className="text-xs whitespace-nowrap">{label}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
