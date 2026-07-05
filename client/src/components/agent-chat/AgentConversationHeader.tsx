import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { MoreVertical, Pencil, Copy, Check, ChevronRight, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAgentChat } from '../../context/AgentChatContext'
import { useDesktop } from '../../hooks/useDesktop'
import { cn } from '../../lib/utils'

/**
 * The conversation title bar for the Agent-Mode surface — a quiet breadcrumb
 * (`<project path> / <conversation title>`) with a `⋮` overflow menu whose
 * primary action is Rename (inline edit), followed by copy-to-clipboard helpers.
 * Only renders for an ACTIVE conversation; designed to sit flush at the top of
 * the thread, reading as chrome rather than content. Hand-rolled glass menu to
 * match `AgentMissionSelector` (no Radix dep); closes on outside-click / Esc.
 */
export function AgentConversationHeader() {
  const { t } = useTranslation('agent')
  const { active, renameConversation, deleteConversation, startNewConversation } = useAgentChat()
  const { projects } = useDesktop()
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const project = active?.pinned_project_id
    ? projects.find((p) => p.id === active.pinned_project_id) ?? null
    : null
  const title = active?.title?.trim() || t('header.untitled')

  // Close the menu on outside-click / Esc.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // A closed menu discards a pending delete confirmation.
  useEffect(() => { if (!menuOpen) setConfirmingDelete(false) }, [menuOpen])

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [editing])

  const startRename = useCallback(() => {
    setDraft(active?.title ?? '')
    setEditing(true)
    setMenuOpen(false)
  }, [active?.title])

  const commitRename = useCallback(async () => {
    if (!active) return
    setEditing(false)
    if ((active.title ?? '') === draft.trim()) return
    try {
      await renameConversation(active.id, draft)
    } catch {
      toast.error(t('header.renameFailed'))
    }
  }, [active, draft, renameConversation, t])

  const copy = useCallback(async (value: string, key: string) => {
    setMenuOpen(false)
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400)
    } catch {
      toast.error(t('header.copyFailed'))
    }
  }, [t])

  const doDelete = useCallback(async () => {
    if (!active) return
    setMenuOpen(false)
    setConfirmingDelete(false)
    try {
      // deleteConversation clears the active thread when it's the one deleted,
      // so the Agent-Mode surface falls back to the "+ New Mission" screen.
      await deleteConversation(active.id)
      startNewConversation(active.pinned_project_id)
    } catch {
      toast.error(t('header.deleteFailed'))
    }
  }, [active, deleteConversation, startNewConversation, t])

  if (!active) return null

  const menuItems: Array<{ id: string; label: string; value: string } | 'divider'> = [
    { id: 'name', label: t('header.copyName'), value: active.title ?? title },
    { id: 'id', label: t('header.copyId'), value: active.id },
    ...(project
      ? [
          { id: 'project', label: t('header.copyProject'), value: project.name },
          { id: 'path', label: t('header.copyProjectPath'), value: project.path },
        ]
      : []),
  ]

  return (
    <div
      ref={rootRef}
      data-agent-interactive
      // h-12 matches the sidebar headers so this bar's bottom border aligns with
      // the sidebars' header divider across the whole app width.
      className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border px-4"
    >
      {/* Breadcrumb — muted project path, then the conversation title (or its
          inline editor). Truncates gracefully on narrow widths. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {project && (
          <>
            <span className="max-w-[42%] shrink-0 truncate font-mono text-[12px] text-foreground/35" title={project.path}>
              {project.path}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/25" aria-hidden />
          </>
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
            }}
            placeholder={t('header.renamePlaceholder')}
            className="min-w-0 flex-1 rounded-md border border-accent-primary/40 bg-surface/60 px-2 py-0.5 text-sm text-foreground outline-none focus:border-accent-primary/70"
            maxLength={200}
          />
        ) : (
          <button
            type="button"
            onDoubleClick={startRename}
            title={t('header.renameHint')}
            className="min-w-0 flex-1 truncate text-left font-medium text-foreground/85"
          >
            {title}
          </button>
        )}
      </div>

      {/* ⋮ overflow menu */}
      <button
        type="button"
        data-testid="agent-conv-menu-trigger"
        aria-label={t('header.menu')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-surface hover:text-foreground/80',
          menuOpen && 'bg-surface text-foreground/80',
        )}
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            role="menu"
            data-testid="agent-conv-menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="absolute right-3 top-11 z-50 min-w-[220px] overflow-hidden rounded-xl border border-border/50 bg-card/95 p-1 shadow-2xl backdrop-blur-xl"
          >
            {confirmingDelete ? (
              // Inline confirm — stays in the menu; confirm deletes + returns to
              // the "+ New Mission" screen, cancel drops back to the menu.
              <div className="p-2" data-testid="agent-conv-delete-confirm">
                <p className="px-1 pb-2.5 text-xs leading-relaxed text-foreground/70">
                  {t('header.deleteConfirm')}
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    data-testid="agent-conv-delete-confirm-btn"
                    onClick={() => void doDelete()}
                    className="flex-1 rounded-lg bg-destructive/90 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-destructive"
                  >
                    {t('header.delete')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="flex-1 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-surface/80"
                  >
                    {t('common:actions.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <>
            <button
              type="button"
              role="menuitem"
              data-testid="agent-conv-rename"
              onClick={startRename}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-surface/80"
            >
              <Pencil className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
              {t('header.rename')}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="agent-conv-delete"
              onClick={() => setConfirmingDelete(true)}
              className="group/del flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0 text-foreground/50 group-hover/del:text-destructive" />
              {t('header.delete')}
            </button>

            <div className="my-1 h-px bg-border/50" />

            {menuItems.map((item) =>
              item === 'divider' ? null : (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-testid={`agent-conv-copy-${item.id}`}
                  onClick={() => void copy(item.value, item.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-surface/80"
                >
                  {copied === item.id ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-accent-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                </button>
              ),
            )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
