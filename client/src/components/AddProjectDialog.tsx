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
import { cn } from '../lib/utils'
import type { ProviderId } from '../lib/provider-capabilities'

interface AddProjectDialogProps {
  open: boolean
  onClose: () => void
  /** Opens the Project Builder (greenfield path). When absent the chooser
   *  pre-screen is skipped and the dialog behaves exactly as before. */
  onOpenBuilder?: () => void
}

type Provider = ProviderId

// Canonical ordering — the first selected provider becomes the project primary.
// Providers detected by the server but not listed here still render (appended in
// discovery order), so a new provider needs no edit to appear in the dialog.
const PROVIDER_ORDER: Provider[] = ['claude', 'codex', 'gemini']

// Display metadata per provider id; unknown ids fall back to a neutral chip.
const PROVIDER_META: Record<string, { icon: string; label: string }> = {
  claude: { icon: '🤖', label: 'Claude' },
  codex: { icon: '⚡', label: 'Codex' },
  gemini: { icon: '✨', label: 'Gemini' },
}

// Render order: known providers (canonical), then any extra detected ones.
function providerRenderOrder(avail: Record<string, boolean>): string[] {
  const known = PROVIDER_ORDER.filter((id) => id in avail)
  const extras = Object.keys(avail).filter((id) => !PROVIDER_ORDER.includes(id))
  return [...known, ...extras]
}

export function AddProjectDialog({ open, onClose, onOpenBuilder }: AddProjectDialogProps) {
  // Existing|New chooser pre-screen (add-project-builder). Only when the
  // Project Builder is enabled AND the parent wired the Builder open callback;
  // otherwise the dialog is byte-identical to the pre-Builder behaviour.
  const chooserEnabled = FEATURE_PROJECT_BUILDER && !!onOpenBuilder
  const [step, setStep] = useState<'choose' | 'existing'>(chooserEnabled ? 'choose' : 'existing')
  // Multi-select: a project can be created with one or both providers. When both
  // are available we pre-select both; the user can deselect down to one (but
  // never zero). The first in canonical order is the primary/default provider.
  const [selectedProviders, setSelectedProviders] = useState<Set<Provider>>(new Set(['claude']))
  const [projectPath, setProjectPath] = useState('')
  const [projectName, setProjectName] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  // Initial render default (claude + codex visible immediately, no flash); the
  // /available-providers fetch overwrites this with the real server map, which
  // also adds any beta-gated provider (e.g. gemini) when enabled.
  const [availableProviders, setAvailableProviders] = useState<Record<string, boolean>>({ claude: true, codex: false })
  const [installModalOpen, setInstallModalOpen] = useState(false)

  const { t } = useTranslation('setup')
  const { addProject, startSetupWizard, setActiveProjectId } = useDesktop()
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
        // Honour the server's real availability map. Providers gated off by env
        // (codex SPECRAILS_CODEX_BETA=0 reports false; gemini opt-in is omitted)
        // simply don't appear / aren't selectable here.
        const avail: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(data)) {
          if (k === 'tiers') continue
          avail[k] = Boolean(v)
        }
        setAvailableProviders(avail)
        // Default selection: every available provider is pre-selected, so the
        // common "I have these" case sets up a multi-provider project in one
        // click. The user can deselect down to one before submitting.
        const next = new Set<Provider>()
        for (const id of providerRenderOrder(avail)) if (avail[id]) next.add(id)
        if (next.size === 0) next.add('claude') // keep submit gating to drive the empty state
        setSelectedProviders(next)
      })
      .catch(() => { /* ignore — defaults to claude */ })
  }, [open])

  function toggleProvider(p: Provider) {
    setSelectedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(p)) {
        if (next.size === 1) return prev // never deselect the last one
        next.delete(p)
      } else {
        next.add(p)
      }
      return next
    })
  }

  // Ordered list (primary first) for submission + summary.
  const orderedSelected = providerRenderOrder(availableProviders).filter((p) => selectedProviders.has(p) && availableProviders[p])

  async function handleAdd() {
    const trimmedPath = projectPath.trim()
    if (!trimmedPath) {
      toast.error(t('addProject.errors.pathRequired'))
      return
    }

    if (orderedSelected.length === 0) {
      toast.error(t('addProject.errors.selectProvider'))
      return
    }

    setIsAdding(true)
    try {
      const data = await addProject(trimmedPath, projectName.trim() || undefined, orderedSelected)
      if (!data) return
      const { project } = data

      if (data.has_specrails === false) {
        resetAndClose()
        setActiveProjectId(project.id)
        startSetupWizard(project.id)
      } else {
        toast.success(t('addProject.toasts.registered', { name: project.name }))
        resetAndClose()
      }
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
      <DialogContent movableResizable className="max-w-md">
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

          {/* Provider selector — multi-select. Pick one or both. */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('addProject.providersLabel')}</label>
            <div className="flex gap-2">
              {providerRenderOrder(availableProviders).map((id) => {
                const { icon, label } = PROVIDER_META[id] ?? { icon: '•', label: id }
                const avail = availableProviders[id]
                const checked = selectedProviders.has(id) && avail
                return (
                  <button
                    key={id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    disabled={!avail}
                    onClick={() => toggleProvider(id)}
                    data-testid={`provider-toggle-${id}`}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-left transition-colors text-xs',
                      'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      checked
                        ? 'border-accent-primary/60 bg-accent-primary/10 text-foreground'
                        : 'border-border/30 text-muted-foreground hover:border-border/60',
                      !avail && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border text-[9px] leading-none',
                        checked ? 'border-accent-primary bg-accent-primary text-background' : 'border-border/50'
                      )}
                      aria-hidden
                    >{checked ? '✓' : ''}</span>
                    <span>{icon}</span>
                    <span className="font-medium">{label}</span>
                    {!avail && (
                      <span className="text-[9px] text-muted-foreground/60">{t('addProject.notFound')}</span>
                    )}
                  </button>
                )
              })}
            </div>
            <p className="text-[9px] text-muted-foreground/70">
              {orderedSelected.length > 1
                ? t('addProject.multiProviderHint')
                : t('addProject.singleProviderHint')}
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
            disabled={isAdding || !projectPath.trim() || noProviderAvailable || orderedSelected.length === 0 || prereqsBlock || prereqLoading}
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
