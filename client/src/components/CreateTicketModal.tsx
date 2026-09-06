import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'
import type { TicketStatus, TicketPriority } from '../types'
import { RepositoryScopeSelector } from './RepositoryScopeSelector'

// ─── Props ──────────────────────────────────────────────────────────────────

interface CreateTicketModalProps {
  open: boolean
  allLabels: string[]
  onClose: () => void
  onCreate: (ticket: {
    title: string
    description?: string
    status?: TicketStatus
    priority?: TicketPriority
    labels?: string[]
    repositoryIds?: string[]
  }) => Promise<boolean>
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CreateTicketModal({ open, allLabels, onClose, onCreate }: CreateTicketModalProps) {
  const { t } = useTranslation('tickets')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<TicketStatus>('todo')
  const [priority, setPriority] = useState<TicketPriority>('medium')
  const [labels, setLabels] = useState<string[]>([])
  const [repositoryIds, setRepositoryIds] = useState<string[] | undefined>()
  const [labelInput, setLabelInput] = useState('')
  const [saving, setSaving] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)

  // Focus title on open
  useEffect(() => {
    if (open) {
      setTimeout(() => titleRef.current?.focus(), 100)
    }
  }, [open])

  // Reset form on close
  useEffect(() => {
    if (!open) {
      setTitle('')
      setDescription('')
      setStatus('todo')
      setPriority('medium')
      setLabels([])
      setRepositoryIds(undefined)
      setLabelInput('')
    }
  }, [open])

  const labelSuggestions = useMemo(() => {
    if (!labelInput.trim()) return []
    const q = labelInput.toLowerCase()
    return allLabels
      .filter((l) => l.toLowerCase().includes(q) && !labels.includes(l))
      .slice(0, 5)
  }, [labelInput, allLabels, labels])

  const addLabel = useCallback((label: string) => {
    const trimmed = label.trim()
    if (trimmed && !labels.includes(trimmed)) {
      setLabels((prev) => [...prev, trimmed])
    }
    setLabelInput('')
  }, [labels])

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return
    setSaving(true)
    const ok = await onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority,
      labels: labels.length > 0 ? labels : undefined,
      ...(repositoryIds ? { repositoryIds } : {}),
    })
    setSaving(false)
    if (ok) {
      toast.success(t('createModal.toast.created'))
      onClose()
    } else {
      toast.error(t('createModal.toast.createFailed'))
    }
  }, [title, description, status, priority, labels, repositoryIds, onCreate, onClose, t])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent movableResizable className="max-w-lg glass-card">
        <DialogHeader>
          <DialogTitle>{t('createModal.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Title */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              {t('fields.title')} <span className="text-red-400 aurora-light:text-destructive">*</span>
            </label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && title.trim()) handleSubmit()
              }}
              placeholder={t('createModal.titlePlaceholder')}
              className="w-full h-8 rounded border border-border bg-input px-3 text-xs text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              {t('fields.description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder={t('fields.markdownPlaceholder')}
              className="w-full rounded border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-y min-h-[80px]"
            />
            <span className="text-[9px] text-muted-foreground mt-0.5 block">{t('fields.supportsMarkdown')}</span>
          </div>

          {/* Status + Priority row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                {t('fields.status')}
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TicketStatus)}
                className="w-full h-7 rounded border border-border bg-input px-2 text-xs text-foreground"
              >
                <option value="todo">{t('ticketStatus.todo')}</option>
                <option value="in_progress">{t('ticketStatus.inProgress')}</option>
                <option value="done">{t('ticketStatus.done')}</option>
                <option value="cancelled">{t('ticketStatus.cancelled')}</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                {t('fields.priority')}
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TicketPriority)}
                className="w-full h-7 rounded border border-border bg-input px-2 text-xs text-foreground"
              >
                <option value="critical">{t('priority.critical')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="medium">{t('priority.medium')}</option>
                <option value="low">{t('priority.low')}</option>
              </select>
            </div>
          </div>

          <RepositoryScopeSelector value={repositoryIds} onChange={setRepositoryIds} disabled={saving} />

          {/* Labels */}
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              {t('fields.labels')}
            </label>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent/60 text-foreground/70"
                >
                  {label}
                  <button
                    type="button"
                    onClick={() => setLabels((prev) => prev.filter((l) => l !== label))}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <XCircle className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="relative">
              <input
                ref={labelInputRef}
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && labelInput.trim()) {
                    e.preventDefault()
                    addLabel(labelInput)
                  }
                }}
                placeholder={t('createModal.labelsPlaceholder')}
                className="w-full h-6 rounded border border-border bg-input px-2 text-[10px] text-foreground placeholder:text-muted-foreground"
              />
              {labelSuggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-0.5 rounded border border-border/50 bg-popover shadow-lg z-10 py-0.5">
                  {labelSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        addLabel(suggestion)
                      }}
                      className="w-full text-left px-2 py-1 text-[10px] hover:bg-accent/50 text-foreground/80"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={saving || !title.trim()}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            {saving ? t('createModal.creating') : t('createModal.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
