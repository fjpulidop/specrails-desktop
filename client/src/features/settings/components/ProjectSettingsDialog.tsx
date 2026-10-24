import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useDesktop } from '../../../hooks/useDesktop'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog'
import { PROJECT_SETTINGS_SECTIONS, type ProjectSettingsSectionId } from './project-settings-sections'

type SectionId = ProjectSettingsSectionId

/**
 * Project settings as a MODAL (Agent Mode — the /settings route belongs to the
 * Kanban surface). Mirrors the Global Settings / Docs dialogs exactly: same
 * resizable `workspace` DialogContent, same
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
      <DialogContent size="workspace" movableResizable persistKey="specrails.modal.project-settings">
        <DialogHeader icon={<Settings />}>
          <DialogTitle>
            {project ? t('projectDialog.title', { name: project.name }) : t('page.title')}
          </DialogTitle>
          <DialogDescription>{t('projectDialog.description')}</DialogDescription>
        </DialogHeader>

        {/* Split pane: the nav and the section content scroll independently. */}
        <DialogBody className="flex gap-5 overflow-hidden py-3 pr-2">
          {/* Left section nav — same chrome as the Global Settings dialog */}
          <nav aria-label={t('projectDialog.navLabel')} className="w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border pr-2">
            {PROJECT_SETTINGS_SECTIONS.map((s) => {
              const Icon = s.icon
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSection(s.id)}
                  aria-current={activeSection === s.id ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeSection === s.id
                      ? 'bg-accent-primary/15 font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{t(s.labelKey)}</span>
                </button>
              )
            })}
          </nav>

          {/* Active section content — fills the fixed-height dialog and scrolls,
              so switching sections never resizes the modal. */}
          <div className="min-w-0 flex-1 overflow-y-auto pr-1 pb-4">
            {PROJECT_SETTINGS_SECTIONS.map((section) => (
              <div key={section.id} className={paneCls(section.id)}>
                {section.panes.map((Pane, i) => <Pane key={i} />)}
              </div>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
