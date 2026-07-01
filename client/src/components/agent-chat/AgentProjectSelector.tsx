import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { Home, Folder, ChevronDown, Check, Search } from 'lucide-react'
import { useDesktop } from '../../hooks/useDesktop'

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
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = projects.find((p) => p.id === pinnedProjectId) ?? null
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects
  }, [projects, query])

  const choose = (id: string | null) => {
    onSelect(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative" ref={ref} data-agent-interactive>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-foreground hover:bg-surface/70"
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
            className="absolute left-0 top-full z-10 mt-1 w-64 overflow-hidden rounded-xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
              <Search className="h-3.5 w-3.5 text-foreground/40" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('project.searchPlaceholder')}
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
              />
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-foreground/40">{t('project.recents')}</div>
              <Row icon={<Home className="h-4 w-4" />} label={t('project.home')} active={!pinnedProjectId} onClick={() => choose(null)} index={0} />
              {filtered.map((p, i) => (
                <Row
                  key={p.id}
                  icon={<Folder className="h-4 w-4 text-accent-primary" />}
                  label={p.name}
                  active={p.id === pinnedProjectId}
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
  icon,
  label,
  active,
  onClick,
  index,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  index: number
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.14, delay: Math.min(index * 0.03, 0.18) }}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface/70"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {active && <Check className="h-3.5 w-3.5 text-accent-primary" />}
    </motion.button>
  )
}
