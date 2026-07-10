import { useState, useRef, useEffect, useMemo, useId, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { Home, Folder, ChevronDown, Check, Search } from 'lucide-react'
import { useDesktop } from '../../hooks/useDesktop'
import {
  AGENT_SELECTOR_POPOVER_CLASS,
  AGENT_SELECTOR_ROW_CLASS,
  AGENT_SELECTOR_TRIGGER_CLASS,
} from './AgentToolbarSelector'

interface Props {
  pinnedProjectId: string | null
  onSelect: (projectId: string | null) => void
}

/** Cursor-style project dropdown: Home (app-global) + project list + search. */
export function AgentProjectSelector({ pinnedProjectId, onSelect }: Props) {
  const { t } = useTranslation('agent')
  const { projects } = useDesktop()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()

  const closeDropdown = useCallback((restoreFocus = false) => {
    setOpen(false)
    setQuery('')
    setHighlighted(0)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeDropdown()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, closeDropdown])

  const current = projects.find((p) => p.id === pinnedProjectId) ?? null
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  const optionCount = filtered.length + 1

  useEffect(() => {
    // A typed query should put Enter on the first actual match, not Home.
    // No matches means no implicit action: Enter must never silently unpin the
    // current project by falling through to the Home row.
    setHighlighted(query.trim() ? (filtered.length > 0 ? 1 : -1) : 0)
  }, [query, filtered.length])

  const openDropdown = () => {
    const index = pinnedProjectId ? projects.findIndex((p) => p.id === pinnedProjectId) : -1
    setHighlighted(index >= 0 ? index + 1 : 0)
    setOpen(true)
  }

  const choose = (id: string | null) => {
    onSelect(id)
    closeDropdown(true)
  }

  const chooseHighlighted = () => {
    if (highlighted < 0) return
    if (highlighted === 0) choose(null)
    else {
      const project = filtered[highlighted - 1]
      if (project) choose(project.id)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openDropdown()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setHighlighted((currentIndex) => (currentIndex + delta + optionCount) % optionCount)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      chooseHighlighted()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeDropdown(true)
    }
  }

  return (
    <div className="relative" ref={ref} data-agent-interactive onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeDropdown() : openDropdown())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        className={AGENT_SELECTOR_TRIGGER_CLASS}
      >
        {current ? <Folder className="h-3.5 w-3.5 text-accent-primary" /> : <Home className="h-3.5 w-3.5 text-foreground/70" />}
        <span className="max-w-[160px] truncate">{current ? current.name : t('project.home')}</span>
        <ChevronDown className="h-3.5 w-3.5 text-foreground/50" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className={`absolute left-0 top-full z-10 mt-1 w-64 ${AGENT_SELECTOR_POPOVER_CLASS}`}
          >
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
              <Search className="h-3.5 w-3.5 text-foreground/40" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                role="combobox"
                placeholder={t('project.searchProjectsPlaceholder')}
                aria-label={t('project.searchProjectsPlaceholder')}
                aria-expanded={open}
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-activedescendant={highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined}
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
              />
            </div>
            <div
              id={listboxId}
              role="listbox"
              aria-label={t('project.allProjects')}
              className="max-h-72 overflow-y-auto py-1"
            >
              <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-foreground/40">{t('project.recents')}</div>
              <Row
                id={`${listboxId}-option-0`}
                icon={<Home className="h-4 w-4" />}
                label={t('project.home')}
                active={!pinnedProjectId}
                highlighted={highlighted === 0}
                onMouseEnter={() => setHighlighted(0)}
                onClick={() => choose(null)}
                index={0}
              />
              {filtered.map((p, i) => (
                <Row
                  key={p.id}
                  id={`${listboxId}-option-${i + 1}`}
                  icon={<Folder className="h-4 w-4 text-accent-primary" />}
                  label={p.name}
                  active={p.id === pinnedProjectId}
                  highlighted={highlighted === i + 1}
                  onMouseEnter={() => setHighlighted(i + 1)}
                  onClick={() => choose(p.id)}
                  index={i + 1}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Row({
  id,
  icon,
  label,
  active,
  highlighted,
  onMouseEnter,
  onClick,
  index,
}: {
  id: string
  icon: React.ReactNode
  label: string
  active: boolean
  highlighted: boolean
  onMouseEnter: () => void
  onClick: () => void
  index: number
}) {
  return (
    <motion.button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.14, delay: Math.min(index * 0.03, 0.18) }}
      className={`${AGENT_SELECTOR_ROW_CLASS} ${highlighted ? 'bg-surface/70' : ''}`}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {active && <Check className="h-3.5 w-3.5 text-accent-primary" />}
    </motion.button>
  )
}
