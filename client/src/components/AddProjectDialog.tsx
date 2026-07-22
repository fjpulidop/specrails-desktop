import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FolderOpen } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { useDesktop } from '../hooks/useDesktop'
import { FEATURE_PROJECT_BUILDER } from '../lib/feature-flags'
import { FolderGit2, Sparkles } from 'lucide-react'
import { usePrerequisites } from '../hooks/usePrerequisites'
import { PrerequisitesPanel } from './PrerequisitesPanel'
import { InstallInstructionsModal } from './InstallInstructionsModal'

interface AddProjectDialogProps {
  open: boolean
  onClose: () => void
  /** Opens the Project Builder (greenfield path). When absent the chooser
   *  pre-screen is skipped and the dialog behaves exactly as before. */
  onOpenBuilder?: () => void
}

export function AddProjectDialog({ open, onClose, onOpenBuilder }: AddProjectDialogProps) {
  // Existing|New chooser pre-screen (add-project-builder). Only when the
  // Project Builder is enabled AND the parent wired the Builder open callback;
  // otherwise the dialog is byte-identical to the pre-Builder behaviour.
  const chooserEnabled = FEATURE_PROJECT_BUILDER && !!onOpenBuilder
  const [step, setStep] = useState<'choose' | 'existing'>(chooserEnabled ? 'choose' : 'existing')
  const [projectPath, setProjectPath] = useState('')
  const [projectName, setProjectName] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  // Providers are auto-detected server-side (global-core-zero-friction) — the
  // dialog only surfaces a warning when nothing is detected. Registration is
  // never blocked on providers: the project registers and offers providers as
  // soon as one is detected.
  const [availableProviders, setAvailableProviders] = useState<Record<string, boolean>>({ claude: true })
  const [installModalOpen, setInstallModalOpen] = useState(false)

  const { t } = useTranslation('setup')
  const { addProject } = useDesktop()
  const { status: prereqStatus, isLoading: prereqLoading, error: prereqError, recheck: prereqRecheck } = usePrerequisites()

  const missingToolsLabel = useMemo(() => {
    if (!prereqStatus || prereqStatus.ok) return null
    const labels = prereqStatus.missingRequired.map((item) => item.label)
    if (labels.length === 0) return null
    return t('addProject.toolsRequired', { tools: labels.join(', '), count: labels.length })
  }, [prereqStatus, t])

  // Soft block: only enforce gating when we have a definitive negative answer.
  // If the fetch errored we let the user proceed and rely on the server install guard.
  const prereqsBlock = prereqStatus !== null && !prereqStatus.ok && !prereqError

  useEffect(() => {
    if (!open) return
    fetch('/api/available-providers')
      .then((r) => r.json())
      .then((data: Record<string, unknown>) => {
        // Only used for the zero-providers-detected warning banner.
        const avail: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(data)) {
          if (k === 'tiers' || k === 'providerIssues' || k === 'launchDescriptors') continue
          if (typeof v === 'boolean') avail[k] = v
        }
        setAvailableProviders(avail)
      })
      .catch(() => { /* ignore — defaults to claude */ })
  }, [open])

  async function handleAdd() {
    const trimmedPath = projectPath.trim()
    if (!trimmedPath) {
      toast.error(t('addProject.errors.pathRequired'))
      return
    }

    setIsAdding(true)
    try {
      // No provider selection: the server registers with the detected set and
      // assembles the workspace silently in the background (no wizard).
      const data = await addProject(trimmedPath, projectName.trim() || undefined)
      if (!data) return
      toast.success(t('addProject.toasts.registered', { name: data.project.name }))
      resetAndClose()
    } catch (err) {
      toast.error(t('addProject.errors.addFailed'), { description: (err as Error).message })
    } finally {
      setIsAdding(false)
    }
  }

  function resetAndClose() {
    setProjectPath('')
    setProjectName('')
    setStep(chooserEnabled ? 'choose' : 'existing')
    onClose()
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) resetAndClose()
  }

  const noProviderAvailable = !Object.values(availableProviders).some(Boolean)

  if (step === 'choose') {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4" />
              {t('addProject.title')}
            </DialogTitle>
            <DialogDescription>{t('addProject.chooser.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <button
              type="button"
              data-testid="chooser-existing"
              onClick={() => setStep('existing')}
              className="flex flex-col items-start gap-2 rounded-lg border border-border/40 p-4 text-left transition-colors hover:border-accent-primary/50 hover:bg-accent-primary/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <FolderGit2 className="h-5 w-5 text-accent-info" />
              <span className="text-sm font-medium">{t('addProject.chooser.existingTitle')}</span>
              <span className="text-[11px] text-muted-foreground">{t('addProject.chooser.existingDescription')}</span>
            </button>
            <button
              type="button"
              data-testid="chooser-new"
              onClick={() => { resetAndClose(); onOpenBuilder?.() }}
              className="flex flex-col items-start gap-2 rounded-lg border border-border/40 p-4 text-left transition-colors hover:border-accent-highlight/50 hover:bg-accent-highlight/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Sparkles className="h-5 w-5 text-accent-highlight" />
              <span className="text-sm font-medium">{t('addProject.chooser.newTitle')}</span>
              <span className="text-[11px] text-muted-foreground">{t('addProject.chooser.newDescription')}</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        movableResizable
        className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-x-hidden"
        data-testid="existing-project-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            {t('addProject.title')}
          </DialogTitle>
          <DialogDescription>
            {t('addProject.description')}
          </DialogDescription>
        </DialogHeader>

        {noProviderAvailable && (
          <p className="text-xs text-destructive bg-destructive/10 rounded-md p-2">
            {t('addProject.noProviderDetected')}
          </p>
        )}

        <PrerequisitesPanel
          status={prereqStatus}
          isLoading={prereqLoading}
          error={prereqError}
          onMoreInfo={() => setInstallModalOpen(true)}
          onRefresh={prereqRecheck}
        />

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              {t('addProject.pathLabel')} <span className="text-destructive">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                placeholder={t('addProject.pathPlaceholder')}
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleAdd() }}
                autoFocus
                className="flex-1"
              />
              {IS_TAURI && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  title={t('addProject.browseForFolder')}
                  onClick={async () => {
                    try {
                      const { open } = await import('@tauri-apps/plugin-dialog')
                      const selected = await open({ directory: true, multiple: false, title: t('addProject.selectProjectFolder') })
                      if (typeof selected === 'string' && selected) {
                        setProjectPath(selected)
                        if (!projectName) {
                          setProjectName(selected.split('/').filter(Boolean).pop() ?? '')
                        }
                      }
                    } catch {
                      // Tauri dialog not available — user can still type path
                    }
                  }}
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {t('addProject.pathHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              {t('addProject.nameLabel')} <span className="text-muted-foreground">{t('addProject.optional')}</span>
            </label>
            <Input
              placeholder={t('addProject.namePlaceholder')}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleAdd() }}
            />
            <p className="text-[10px] text-muted-foreground">
              {t('addProject.nameHint')}
            </p>
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={isAdding}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={isAdding || !projectPath.trim() || prereqsBlock || prereqLoading}
            title={prereqsBlock ? missingToolsLabel ?? undefined : undefined}
            data-testid="add-project-submit"
          >
            {isAdding ? t('addProject.adding') : t('addProject.submit')}
          </Button>
        </DialogFooter>

        <InstallInstructionsModal
          open={installModalOpen}
          onClose={() => setInstallModalOpen(false)}
          status={prereqStatus}
          onRecheck={prereqRecheck}
          isRechecking={prereqLoading}
        />
      </DialogContent>
    </Dialog>
  )
}
