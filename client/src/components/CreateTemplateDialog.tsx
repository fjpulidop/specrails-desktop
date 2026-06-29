import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus, Trash2, GripVertical } from 'lucide-react'
import { getApiBase } from '../lib/api'
import type { CommandInfo, JobTemplate } from '../types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'

interface CreateTemplateDialogProps {
  open: boolean
  template?: JobTemplate | null  // when editing
  commands?: CommandInfo[]       // available specrails commands for autocomplete
  onClose: () => void
  onSaved: (template: JobTemplate) => void
}

export function CreateTemplateDialog({ open, template, commands = [], onClose, onSaved }: CreateTemplateDialogProps) {
  const { t } = useTranslation('commands')
  const isEditing = template != null
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<string[]>([''])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setName(template?.name ?? '')
      setDescription(template?.description ?? '')
      setSteps(template?.commands.length ? [...template.commands] : [''])
    }
  }, [open, template])

  function handleClose() {
    if (submitting) return
    onClose()
  }

  function addStep() {
    setSteps((prev) => [...prev, ''])
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index))
  }

  function setStep(index: number, value: string) {
    setSteps((prev) => prev.map((c, i) => (i === index ? value : c)))
  }

  function moveStep(index: number, direction: 'up' | 'down') {
    const next = [...steps]
    const swap = direction === 'up' ? index - 1 : index + 1
    if (swap < 0 || swap >= next.length) return
    ;[next[index], next[swap]] = [next[swap], next[index]]
    setSteps(next)
  }

  async function handleSubmit() {
    const trimmedName = name.trim()
    if (!trimmedName) { toast.error(t('templateDialog.errors.nameRequired')); return }
    const filtered = steps.map((c) => c.trim()).filter(Boolean)
    if (filtered.length === 0) { toast.error(t('templateDialog.errors.stepRequired')); return }

    setSubmitting(true)
    try {
      const url = isEditing
        ? `${getApiBase()}/templates/${template!.id}`
        : `${getApiBase()}/templates`
      const method = isEditing ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim() || null,
          commands: filtered,
        }),
      })
      const data = await res.json() as { template?: JobTemplate; error?: string }
      if (!res.ok) throw new Error(data.error ?? t('templateDialog.errors.saveFailed'))
      toast.success(isEditing ? t('templateDialog.toasts.updated') : t('templateDialog.toasts.created'))
      onSaved(data.template!)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent movableResizable className="max-w-lg glass-card">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('templateDialog.editTitle') : t('templateDialog.newTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('templateDialog.nameLabel')}</label>
            <Input
              placeholder={t('templateDialog.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('templateDialog.descriptionLabel')}</label>
            <Input
              placeholder={t('templateDialog.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">{t('templateDialog.stepsLabel')}</label>
              <Button variant="ghost" size="sm" onClick={addStep} disabled={submitting} className="h-6 text-xs gap-1 px-2">
                <Plus className="h-3 w-3" />
                {t('common:actions.add')}
              </Button>
            </div>
            {commands.length > 0 && (
              <datalist id="sr-commands-list">
                {commands.map((c) => (
                  <option key={c.slug} value={`/specrails:${c.slug}`}>{c.name}</option>
                ))}
              </datalist>
            )}
            <div className="space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      aria-label={t('templateDialog.aria.moveUp')}
                      onClick={() => moveStep(i, 'up')}
                      disabled={i === 0 || submitting}
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <GripVertical className="h-3 w-3" />
                    </button>
                  </div>
                  <span className="text-xs text-muted-foreground w-4 shrink-0 text-right">{i + 1}.</span>
                  <Input
                    list="sr-commands-list"
                    placeholder={t('templateDialog.stepPlaceholder')}
                    value={step}
                    onChange={(e) => setStep(i, e.target.value)}
                    disabled={submitting}
                    className="font-mono text-xs"
                  />
                  <button
                    type="button"
                    aria-label={t('templateDialog.aria.removeStep')}
                    onClick={() => removeStep(i)}
                    disabled={steps.length <= 1 || submitting}
                    className="p-1 rounded text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={submitting}>
            {t('common:actions.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('common:states.saving') : isEditing ? t('templateDialog.update') : t('templateDialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
