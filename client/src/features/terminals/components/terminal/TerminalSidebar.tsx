import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Terminal as TerminalIcon, X } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import type { TerminalRef } from '../../context/TerminalsContext'

interface TerminalSidebarProps {
  sessions: TerminalRef[]
  activeId: string | null
  onActivate: (id: string) => void
  onRename: (id: string, name: string) => void
  onKill: (id: string) => void
}

export function TerminalSidebar({ sessions, activeId, onActivate, onRename, onKill }: TerminalSidebarProps) {
  const { t } = useTranslation('terminal')
  return (
    <aside
      aria-label={t('sidebar.label')}
      className={cn(
        'w-44 shrink-0 border-l border-border/40 bg-background/70',
        'overflow-y-auto',
      )}
    >
      <ul className="py-1">
        {sessions.map((s) => (
          <SidebarItem
            key={s.id}
            session={s}
            active={s.id === activeId}
            onActivate={() => onActivate(s.id)}
            onRename={(name) => onRename(s.id, name)}
            onKill={() => onKill(s.id)}
          />
        ))}
      </ul>
    </aside>
  )
}

interface SidebarItemProps {
  session: TerminalRef
  active: boolean
  onActivate: () => void
  onRename: (name: string) => void
  onKill: () => void
}

function SidebarItem({ session, active, onActivate, onRename, onKill }: SidebarItemProps) {
  const { t } = useTranslation('terminal')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) {
      setDraft(session.name)
      queueMicrotask(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, session.name])

  function commit() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== session.name) onRename(trimmed)
    setEditing(false)
  }

  function startEditing() {
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setDraft(session.name)
  }

  return (
    <li className="relative group px-1">
      {/* The row is a plain container: the session button and the row actions
          are siblings, never interactive elements nested in a button. */}
      <div
        onDoubleClick={startEditing}
        className={cn(
          'flex items-center gap-1 pr-1 rounded-md text-xs select-none',
          'transition-colors duration-120',
          active
            ? 'bg-border/40 text-foreground border-l-2 border-accent-primary/70'
            : 'text-muted-foreground hover:bg-border/20 hover:text-foreground',
        )}
      >
        {editing ? (
          <div className={cn('flex flex-1 min-w-0 items-center gap-2 py-1.5', active ? 'pl-[calc(0.5rem-2px)]' : 'pl-2')}>
            <TerminalIcon className="h-3 w-3 shrink-0" aria-hidden />
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit() }
                if (e.key === 'Escape') { e.preventDefault(); cancel() }
              }}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              maxLength={64}
              className={cn(
                'flex-1 min-w-0 bg-background/60 border border-border/40 rounded px-1',
                'text-xs text-foreground outline-none focus:ring-1 focus:ring-accent-primary/60',
              )}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={onActivate}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex flex-1 min-w-0 items-center gap-2 py-1.5 rounded-md text-left cursor-pointer',
              active ? 'pl-[calc(0.5rem-2px)]' : 'pl-2',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
            )}
          >
            <TerminalIcon className="h-3 w-3 shrink-0" aria-hidden />
            <span className="flex-1 truncate">{session.name}</span>
          </button>
        )}
        {!editing && (
          <button
            type="button"
            aria-label={t('sidebar.rename', { name: session.name })}
            title={t('sidebar.rename', { name: session.name })}
            onClick={(e) => { e.stopPropagation(); startEditing() }}
            className={cn(
              'inline-flex shrink-0 items-center justify-center h-5 w-5 rounded',
              'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
              'hover:bg-border/40 hover:text-foreground',
              'transition-opacity duration-120',
              active && 'opacity-70',
            )}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          aria-label={t('sidebar.close', { name: session.name })}
          title={t('sidebar.close', { name: session.name })}
          onClick={(e) => { e.stopPropagation(); onKill() }}
          className={cn(
            'inline-flex shrink-0 items-center justify-center h-5 w-5 rounded',
            'text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
            'hover:bg-destructive/20 hover:text-destructive',
            'transition-opacity duration-120',
            active && 'opacity-70',
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </li>
  )
}
