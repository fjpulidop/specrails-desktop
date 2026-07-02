import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings, SlidersHorizontal, Wallet, Activity, TerminalSquare } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useDesktop } from '../../hooks/useDesktop'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog'
import { TerminalSettingsSection } from './TerminalSettingsSection'
import {
  ProjectTelemetrySection,
  ProjectPrePromptsSection,
  ProjectBudgetSection,
} from './ProjectSettingsSections'

const PROJECT_SETTINGS_SECTIONS = [
  { id: 'general', icon: SlidersHorizontal, labelKey: 'projectDialog.nav.general' },
  { id: 'budget', icon: Wallet, labelKey: 'projectDialog.nav.budget' },
  { id: 'telemetry', icon: Activity, labelKey: 'projectDialog.nav.telemetry' },
  { id: 'terminal', icon: TerminalSquare, labelKey: 'projectDialog.nav.terminal' },
] as const

type SectionId = (typeof PROJECT_SETTINGS_SECTIONS)[number]['id']

/**
 * Project settings as a MODAL (Agent Mode — the /settings route belongs to the
 * Kanban surface). Mirrors the Global Settings / Docs dialogs exactly: same
 * movable-resizable DialogContent proportions (max-w-5xl · 92vw · 82vh), same
 * left section nav + scrollable content, all panes mounted and toggled with
 * `hidden` so switching sections never refetches or resizes.
 */
export function ProjectSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('settings')
  const { activeProjectId, projects } = useDesktop()
  const project = projects.find((p) => p.id === activeProjectId)
  const [activeSection, setActiveSection] = useState<SectionId>('general')
  const paneCls = (id: SectionId) => cn('space-y-5', activeSection === id ? '' : 'hidden')

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent movableResizable className="flex max-w-5xl w-[92vw] h-[82vh] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            {project ? t('projectDialog.title', { name: project.name }) : t('page.title')}
          </DialogTitle>
          <DialogDescription>{t('projectDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-5 py-2">
          {/* Left section nav — same chrome as the Global Settings dialog */}
          <nav className="w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border pr-2">
            {PROJECT_SETTINGS_SECTIONS.map((s) => {
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
            <div className={paneCls('general')}>
              <ProjectPrePromptsSection />
            </div>
            <div className={paneCls('budget')}>
              <ProjectBudgetSection />
            </div>
            <div className={paneCls('telemetry')}>
              <ProjectTelemetrySection />
            </div>
            <div className={paneCls('terminal')}>
              <TerminalSettingsSection mode="project" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
