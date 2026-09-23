import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, Check, X, RotateCcw, Ban, Layers, GitPullRequestArrow, MessageSquareText, HelpCircle, ShieldAlert, Loader2 } from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { getDateFnsLocale } from '../../../lib/i18n'
import type { LocalTicket } from '../../../types'
import {
  openAddenda,
  readSpecAddenda,
  SPEC_ADDENDUM_KINDS,
  SPEC_ADDENDUM_MAX_BODY_CHARS,
  type SpecAddendum,
  type SpecAddendumKind,
  type SpecAddendumStatus,
} from '../lib/spec-addenda-core'
import { Button } from '../../../components/ui/button'

// ─── Spec addenda section (spec-addenda) ─────────────────────────────────────
// The premium in-modal surface for iterating on a spec WITHOUT editing its
// description: a list of structured notes with their lifecycle pill, an inline
// add/edit form, and the actions the lifecycle allows. The server is the only
// authority — every mutation is a REST call whose response replaces the local
// list, and a `ticket_updated` broadcast (the prop) re-syncs it.

interface SpecAddendaSectionProps {
  ticket: LocalTicket
  /** Fired with the authoritative list after every successful mutation. */
  onChanged?: (addenda: SpecAddendum[]) => void
}

const KIND_ICON: Record<SpecAddendumKind, typeof Layers> = {
  'change-request': GitPullRequestArrow,
  'review-feedback': MessageSquareText,
  clarification: HelpCircle,
  constraint: ShieldAlert,
}

const STATUS_PILL: Record<SpecAddendumStatus, string> = {
  open: 'border-accent-primary/50 bg-accent-primary/10 text-accent-primary',
  in_flight: 'border-accent-info/50 bg-accent-info/10 text-accent-info animate-pulse',
  applied: 'border-accent-success/50 bg-accent-success/10 text-accent-success',
  dismissed: 'border-border bg-muted/30 text-muted-foreground',
}

const MARKDOWN_CLASS = 'prose prose-invert prose-xs max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-xs prose-headings:font-semibold prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-cyan-300 prose-code:text-[10px] prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded text-foreground/80 text-xs'

interface FormState { kind: SpecAddendumKind; title: string; body: string }
const EMPTY_FORM: FormState = { kind: 'change-request', title: '', body: '' }

type ApiErrorBody = { error?: string; code?: string; detail?: string }

export function SpecAddendaSection({ ticket, onChanged }: SpecAddendaSectionProps) {
  const { t } = useTranslation('tickets')
  const [addenda, setAddenda] = useState<SpecAddendum[]>(() => readSpecAddenda(ticket.addenda))
  const [form, setForm] = useState<FormState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // Re-sync from the ticket prop (WS `ticket_updated` after a claim/settle
  // lands here) — never while the user is mid-edit of the same list.
  useEffect(() => {
    setAddenda(readSpecAddenda(ticket.addenda))
  }, [ticket.id, ticket.updated_at, ticket.addenda])

  useEffect(() => {
    if (form) bodyRef.current?.focus()
  }, [form])

  const openCount = useMemo(() => openAddenda(addenda).length, [addenda])
  const base = `${getApiBase()}/tickets/${ticket.id}/addenda`

  const applyResponse = useCallback((body: { ticket?: LocalTicket; addendum?: SpecAddendum }) => {
    const next = body.ticket ? readSpecAddenda(body.ticket.addenda) : null
    if (next) {
      setAddenda(next)
      onChanged?.(next)
    }
  }, [onChanged])

  const request = useCallback(async (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorBody & { ticket?: LocalTicket; addendum?: SpecAddendum }
      if (!res.ok) {
        if (body.error === 'addendum_in_flight') toast.info(t('addenda.toast.inFlight'))
        else toast.error(body.detail ? `${t('addenda.toast.failed')}: ${body.detail}` : t('addenda.toast.failed'))
        return false
      }
      applyResponse(body)
      return true
    } catch {
      toast.error(t('addenda.toast.failed'))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyResponse, t])

  const startAdd = () => { setEditingId(null); setForm({ ...EMPTY_FORM }); setConfirmDeleteId(null) }
  const startEdit = (a: SpecAddendum) => { setEditingId(a.id); setForm({ kind: a.kind, title: a.title, body: a.body }); setConfirmDeleteId(null) }
  const cancelForm = () => { setForm(null); setEditingId(null) }

  const submit = async () => {
    if (!form || !form.body.trim()) return
    const payload = { kind: form.kind, title: form.title.trim() || undefined, body: form.body }
    const ok = editingId
      ? await request('PATCH', `${base}/${encodeURIComponent(editingId)}`, payload)
      : await request('POST', base, payload)
    if (ok) {
      toast.success(t(editingId ? 'addenda.toast.updated' : 'addenda.toast.added'))
      cancelForm()
    }
  }

  const setStatus = async (a: SpecAddendum, status: 'open' | 'dismissed', force = false) => {
    if (await request('PATCH', `${base}/${encodeURIComponent(a.id)}`, force ? { status, force: true } : { status })) toast.success(t('addenda.toast.updated'))
  }

  const remove = async (a: SpecAddendum) => {
    if (confirmDeleteId !== a.id) { setConfirmDeleteId(a.id); return }
    setConfirmDeleteId(null)
    if (await request('DELETE', `${base}/${encodeURIComponent(a.id)}`)) toast.success(t('addenda.toast.removed'))
  }

  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const who = (createdBy: string): string => t(`addenda.who.${createdBy === 'agent' || createdBy === 'mcp' ? createdBy : 'user'}`)
  const relative = (iso: string): string => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : formatDistanceToNow(d, { addSuffix: true, locale: getDateFnsLocale() })
  }

  const renderForm = () => form && (
    <div data-testid="spec-addenda-form" className="rounded-lg border border-accent-primary/30 bg-accent-primary/[0.04] px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">{t('addenda.form.kind')}</span>
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as SpecAddendumKind })}
            className="h-6 rounded-md border border-border/60 bg-input px-1.5 text-[11px] text-foreground outline-none focus:border-accent-primary/50"
            data-testid="spec-addenda-kind"
          >
            {SPEC_ADDENDUM_KINDS.map((kind) => <option key={kind} value={kind}>{t(`addenda.kind.${kind}`)}</option>)}
          </select>
        </label>
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder={t('addenda.form.titlePlaceholder')}
          className="h-6 min-w-0 flex-1 rounded-md border border-border/60 bg-input px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-accent-primary/50"
          data-testid="spec-addenda-title"
        />
      </div>
      <textarea
        ref={bodyRef}
        value={form.body}
        maxLength={SPEC_ADDENDUM_MAX_BODY_CHARS}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit() }
          if (e.key === 'Escape') { e.preventDefault(); cancelForm() }
        }}
        placeholder={t('addenda.form.bodyPlaceholder')}
        className="w-full min-h-[96px] rounded-md border border-border/60 bg-input px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-accent-primary/50 resize-y"
        data-testid="spec-addenda-body"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] text-muted-foreground">{t('addenda.form.hint')}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={cancelForm} disabled={busy}>{t('addenda.form.cancel')}</Button>
          <Button size="sm" className="h-6 text-[10px]" onClick={() => void submit()} disabled={busy || !form.body.trim()} data-testid="spec-addenda-save">
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
            {t(busy ? 'addenda.form.saving' : 'addenda.form.save')}
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <section data-testid="spec-addenda-section" className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground" title={t('addenda.hint')}>
          <Layers className="h-3 w-3" />
          {t('addenda.title')}
          {addenda.length > 0 && (
            <span
              data-testid="spec-addenda-open-count"
              className={`rounded-full border px-1.5 py-px text-[9px] font-semibold normal-case tracking-normal ${openCount > 0 ? STATUS_PILL.open : 'border-border text-muted-foreground'}`}
            >
              {openCount > 0 ? t('addenda.openCount', { count: openCount }) : addenda.length}
            </span>
          )}
        </span>
        {!form && (
          <button
            type="button"
            onClick={startAdd}
            className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            data-testid="spec-addenda-add"
          >
            <Plus className="h-2.5 w-2.5" />
            {t('addenda.add')}
          </button>
        )}
      </div>

      {form && !editingId && renderForm()}

      {addenda.length === 0 && !form ? (
        <button
          type="button"
          onClick={startAdd}
          className="w-full rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-3 text-left text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
          data-testid="spec-addenda-empty"
        >
          {t('addenda.emptyCta')}
        </button>
      ) : (
        <ul className="space-y-1.5">
          {addenda.map((a) => {
            const Icon = KIND_ICON[a.kind]
            const isOpen = expanded.has(a.id)
            const editingThis = editingId === a.id && form
            const canEdit = a.status === 'open' || a.status === 'dismissed'
            const canDismiss = a.status === 'open' || a.status === 'applied'
            const canReopen = a.status === 'dismissed' || a.status === 'applied'
            const canDelete = a.status !== 'in_flight'
            return (
              <li key={a.id} data-testid={`spec-addendum-${a.id}`} data-status={a.status} className={`rounded-lg border px-3 py-2 transition-colors ${a.status === 'dismissed' ? 'border-border/30 bg-muted/5 opacity-70' : 'border-border/50 bg-muted/15'}`}>
                {editingThis ? renderForm() : (
                  <>
                    <div className="flex items-start gap-2">
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary/80" />
                      <button
                        type="button"
                        onClick={() => toggleExpanded(a.id)}
                        className="min-w-0 flex-1 text-left"
                        aria-expanded={isOpen}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`text-xs font-medium text-foreground/90 ${a.status === 'dismissed' ? 'line-through' : ''}`}>{a.title}</span>
                          <span className="rounded-full border border-border/50 px-1.5 py-px text-[9px] text-muted-foreground">{t(`addenda.kind.${a.kind}`)}</span>
                          <span className={`rounded-full border px-1.5 py-px text-[9px] font-medium ${STATUS_PILL[a.status]}`} title={t(`addenda.statusHint.${a.status}`)} data-testid="spec-addendum-status">
                            {t(`addenda.status.${a.status}`)}
                          </span>
                        </div>
                        {!isOpen && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{a.body}</p>
                        )}
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {canEdit && (
                          <button type="button" title={t('addenda.actions.edit')} aria-label={t('addenda.actions.edit')} onClick={() => startEdit(a)} disabled={busy} className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                        {a.status === 'in_flight' && (
                          <button type="button" title={t('addenda.actions.releaseHint')} aria-label={t('addenda.actions.release')} onClick={() => void setStatus(a, 'open', true)} disabled={busy} className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground" data-testid="spec-addendum-release">
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                        {canReopen && (
                          <button type="button" title={t('addenda.actions.reopen')} aria-label={t('addenda.actions.reopen')} onClick={() => void setStatus(a, 'open')} disabled={busy} className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                        {canDismiss && (
                          <button type="button" title={t('addenda.actions.dismiss')} aria-label={t('addenda.actions.dismiss')} onClick={() => void setStatus(a, 'dismissed')} disabled={busy} className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
                            <Ban className="h-3 w-3" />
                          </button>
                        )}
                        {canDelete && (
                          confirmDeleteId === a.id ? (
                            <span className="flex items-center gap-0.5">
                              <button type="button" title={t('addenda.actions.confirmDelete')} aria-label={t('addenda.actions.confirmDelete')} onClick={() => void remove(a)} disabled={busy} className="rounded p-1 text-destructive transition-colors hover:bg-destructive/10">
                                <Check className="h-3 w-3" />
                              </button>
                              <button type="button" aria-label={t('addenda.form.cancel')} onClick={() => setConfirmDeleteId(null)} className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40">
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ) : (
                            <button type="button" title={t('addenda.actions.delete')} aria-label={t('addenda.actions.delete')} onClick={() => void remove(a)} disabled={busy} className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )
                        )}
                      </div>
                    </div>
                    {isOpen && (
                      <div className="mt-2 space-y-1.5 pl-5">
                        <div className={MARKDOWN_CLASS} data-testid="spec-addendum-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.body}</ReactMarkdown>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-muted-foreground">
                          <span>{relative(a.created_at)} · {t('addenda.meta.by', { who: who(a.created_by) })}</span>
                          {a.run_id && <span className="font-mono">{t('addenda.meta.run', { id: a.run_id.slice(0, 8) })}</span>}
                          {a.applied_at && <span>{t('addenda.meta.applied', { when: relative(a.applied_at) })}</span>}
                          <span className="font-mono">{t('addenda.meta.hash', { hash: a.hash.slice(0, 12) })}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
