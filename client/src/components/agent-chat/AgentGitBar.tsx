import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'motion/react'
import { GitBranch, ChevronDown, Check, Search, Loader2, FolderGit2, Copy } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { subscribeGitChanged } from '../../lib/git-refresh'
import { useDesktop } from '../../hooks/useDesktop'
import { projectRepositories, repositoryApiBase } from '../../lib/project-repositories'

interface GitWorktree {
  path: string
  branch: string | null
  head: string
  isMain: boolean
}

interface GitInfo {
  repositoryId?: string
  git: boolean
  branch: string | null
  detached: boolean
  dirty: boolean
  branches: string[]
  lastCommit: { hash: string; subject: string; at: string } | null
  worktrees?: GitWorktree[]
}

/**
 * Git strip under the composer: current branch (a THEMED dropdown — picking
 * another LOCAL branch checks it out in the project repo) + the last commit
 * subject. Styled with semantic tokens (never the native OS select) so every
 * theme restyles it. Hidden when the pinned project is not a git repo.
 * Refreshes when the mission's turn settles (the agent itself may have
 * switched branches or committed).
 */
export function AgentGitBar({ projectId }: { projectId: string }) {
  const { t } = useTranslation('agent')
  const { isStreaming } = useAgentChat()
  const { projects } = useDesktop()
  const project = projects.find(project => project.id === projectId)
  const repositories = projectRepositories(project)
  const [selection, setSelection] = useState<{ projectId: string; repositoryId: string } | null>(null)
  const repositoryId = selection?.projectId === projectId ? selection.repositoryId : repositories.find(repository => repository.isPrimary)?.id
  const repository = repositories.find(repository => repository.id === repositoryId)
  const [snapshot, setSnapshot] = useState<{ key: string; value: GitInfo } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [open, setOpen] = useState(false)
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const base = `${repositoryApiBase(projectId, repositoryId)}/git`
  const scopeKey = `${base}\0${repository?.path ?? ''}`
  const scopeRef = useRef({ key: scopeKey, epoch: 0 })
  if (scopeRef.current.key !== scopeKey) scopeRef.current = { key: scopeKey, epoch: scopeRef.current.epoch + 1 }
  const scopeEpoch = scopeRef.current.epoch
  const info = snapshot?.key === scopeKey ? snapshot.value : null
  const refreshAbortRef = useRef<AbortController | null>(null)
  const refreshVersionRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current
    refreshAbortRef.current?.abort()
    const controller = new AbortController()
    refreshAbortRef.current = controller
    try {
      const res = await fetch(base, { signal: controller.signal })
      if (!res.ok) throw new Error('unavailable')
      const next = await res.json() as GitInfo
      if (typeof next.git !== 'boolean' || (repositoryId && next.repositoryId && next.repositoryId !== repositoryId)) throw new Error('repository mismatch')
      if (mountedRef.current && scopeRef.current.epoch === scopeEpoch && refreshVersionRef.current === version && !controller.signal.aborted) {
        setSnapshot({ key: scopeKey, value: next })
        setLoadFailed(false)
      }
    } catch {
      if (mountedRef.current && scopeRef.current.epoch === scopeEpoch && refreshVersionRef.current === version && !controller.signal.aborted) {
        setSnapshot(null)
        setLoadFailed(true)
      }
    }
  }, [base, repositoryId, scopeKey, scopeEpoch])

  useEffect(() => {
    setSnapshot(null)
    setLoadFailed(false)
    setSwitching(false)
    setOpen(false)
    setRepositoryOpen(false)
    setQuery('')
    void refresh()
    return () => { ++refreshVersionRef.current; refreshAbortRef.current?.abort() }
  }, [refresh])

  // Turn settled → the agent may have committed or switched branches.
  const prevStreamingRef = useRef(isStreaming)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) void refresh()
    prevStreamingRef.current = isStreaming
  }, [isStreaming, refresh])

  // Client-side repo mutations (PR-card Checkout / Integrate locally / Discard)
  // notify through the git-refresh bus — reflect them here IMMEDIATELY instead
  // of waiting for the next turn settle.
  useEffect(() => {
    return subscribeGitChanged((changedProjectId) => {
      if (changedProjectId === projectId) void refresh()
    })
  }, [projectId, refresh])

  // Click-away closes the dropdown (same pattern as AgentProjectSelector).
  useEffect(() => {
    if (!open && !repositoryOpen) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setOpen(false); setRepositoryOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, repositoryOpen])

  const checkout = useCallback(async (branch: string) => {
    setOpen(false)
    setQuery('')
    if (!info?.git || !branch || branch === info.branch || switching || isStreaming || scopeRef.current.epoch !== scopeEpoch) return
    // Invalidate any read started before the branch mutation.
    ++refreshVersionRef.current
    refreshAbortRef.current?.abort()
    setSwitching(true)
    try {
      const res = await fetch(`${base}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch, ...(repositoryId ? { repositoryId } : {}) }),
      })
      const data = await res.json().catch(() => ({})) as GitInfo & { error?: string }
      if (!mountedRef.current || scopeRef.current.epoch !== scopeEpoch) return
      if (!res.ok) {
        // git refused (dirty tree, unknown branch, …) and touched NOTHING —
        // surface its exact reason and re-sync the strip with the real state.
        toast.error(t('git.switchFailed'), { description: data.error })
        void refresh()
        return
      }
      ++refreshVersionRef.current
      if (typeof data.git !== 'boolean' || (repositoryId && data.repositoryId && data.repositoryId !== repositoryId)) {
        setSnapshot(null)
        setLoadFailed(true)
        return
      }
      setSnapshot({ key: scopeKey, value: data })
      toast.success(t('git.switched', { branch }))
    } catch {
      if (!mountedRef.current || scopeRef.current.epoch !== scopeEpoch) return
      toast.error(t('git.switchFailed'))
      void refresh()
    } finally {
      if (mountedRef.current && scopeRef.current.epoch === scopeEpoch) setSwitching(false)
    }
  }, [base, info, repositoryId, scopeKey, scopeEpoch, switching, isStreaming, t, refresh])

  const filtered = useMemo(() => {
    if (!info) return []
    const q = query.trim().toLowerCase()
    return q ? (info.branches ?? []).filter((b) => b.toLowerCase().includes(q)) : info.branches ?? []
  }, [info, query])

  const showRepositories = repositories.length > 1 || (!!repositoryId && !repository)
  if (!info?.git && !showRepositories && !loadFailed) return null

  const disabled = switching || isStreaming
  const currentLabel = info?.detached ? t('git.detached') : info?.branch ?? t('git.detached')
  // Branches living in a LINKED worktree (rails create them for parallel
  // implementation) can't be checked out here — git refuses "already checked
  // out at <path>". They render grouped with their path and copy it on click.
  const worktreeByBranch = new Map(
    (info?.worktrees ?? []).filter((w) => !w.isMain && w.branch).map((w) => [w.branch as string, w]),
  )
  const switchable = filtered.filter((b) => !worktreeByBranch.has(b))
  const inWorktrees = filtered.filter((b) => worktreeByBranch.has(b))

  const copyWorktreePath = async (w: GitWorktree) => {
    setOpen(false)
    setQuery('')
    try {
      await navigator.clipboard.writeText(w.path)
      toast.success(t('git.worktreePathCopied'), { description: w.path })
    } catch {
      // Clipboard unavailable (permissions) — still show WHERE it lives.
      toast.info?.(w.path)
    }
  }

  return (
    <div ref={rootRef} className="relative mt-1.5 flex min-w-0 items-center gap-2 px-1 text-[11px] text-foreground/50" data-agent-interactive>
      {showRepositories && <div className="relative min-w-0 shrink-0">
        <button type="button" aria-label={t('git.repository')} aria-expanded={repositoryOpen} disabled={switching}
          onClick={() => { setRepositoryOpen(value => !value); setOpen(false) }}
          className="flex max-w-[180px] items-center gap-1.5 rounded-md border border-border/50 bg-surface/60 px-1.5 py-0.5 text-foreground hover:bg-surface disabled:opacity-50">
          <FolderGit2 className="h-3 w-3 shrink-0 text-accent-primary/70" />
          <span className="truncate">{repository?.name ?? t('git.repositoryUnavailable')}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
        {repositoryOpen && <div role="listbox" aria-label={t('git.repository')}
          className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-64 overflow-y-auto rounded-xl border border-border/60 bg-card p-1 shadow-2xl">
          {repositories.map(member => <button key={member.id} type="button" role="option" aria-selected={member.id === repositoryId}
            onClick={() => { setSelection({ projectId, repositoryId: member.id }); setRepositoryOpen(false) }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-foreground hover:bg-surface">
            <span className="min-w-0 flex-1 truncate">{member.name}</span>
            {member.id === repositoryId && <Check className="h-3 w-3" />}
          </button>)}
        </div>}
      </div>}
      {!info?.git && <span role={loadFailed ? 'status' : undefined} className="min-w-0 truncate">
        {loadFailed ? t('git.loadFailed') : info ? t('git.notGit') : <Loader2 className="h-3 w-3 animate-spin" />}
      </span>}
      {loadFailed && <button type="button" onClick={() => void refresh()} className="shrink-0 text-accent-primary hover:underline">{t('git.retry')}</button>}
      {info?.git && <button
        type="button"
        onClick={() => { if (!disabled) { setOpen((o) => !o); setRepositoryOpen(false) } }}
        disabled={disabled}
        aria-label={t('git.branch')}
        aria-expanded={open}
        title={disabled && isStreaming ? t('git.lockedWhileWorking') : t('git.branch')}
        className="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-md border border-border/50 bg-surface/60 px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-surface disabled:opacity-50"
      >
        {switching
          ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent-primary/70" />
          : <GitBranch className="h-3 w-3 shrink-0 text-accent-primary/70" />}
        <span className="min-w-0 truncate">{currentLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-foreground/40" />
      </button>}

      <AnimatePresence>
        {open && info?.git && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            // Anchored ABOVE the trigger — the composer hugs the bottom edge.
            className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-xl"
          >
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
              <Search className="h-3.5 w-3.5 text-foreground/40" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('git.searchPlaceholder')}
                aria-label={t('git.searchPlaceholder')}
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1" role="listbox" aria-label={t('git.branch')}>
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-foreground/40">{t('git.noMatches')}</div>
              )}
              {switchable.map((b, i) => (
                <motion.button
                  key={b}
                  type="button"
                  role="option"
                  aria-selected={b === info.branch}
                  onClick={() => void checkout(b)}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.14, delay: Math.min(i * 0.02, 0.16) }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface/70"
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent-primary/70" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{b}</span>
                  {b === info.branch && <Check className="h-3.5 w-3.5 shrink-0 text-accent-primary" />}
                </motion.button>
              ))}
              {inWorktrees.length > 0 && (
                <>
                  <div className="mt-1 border-t border-border/50 px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-foreground/40">
                    {t('git.worktrees')}
                  </div>
                  {inWorktrees.map((b, i) => {
                    const w = worktreeByBranch.get(b)!
                    return (
                      <motion.button
                        key={b}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => void copyWorktreePath(w)}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.14, delay: Math.min(i * 0.02, 0.16) }}
                        title={t('git.copyWorktreePath')}
                        className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface/70"
                      >
                        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-accent-secondary/80" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-xs">{b}</span>
                          <span className="block truncate text-[10px] text-foreground/40">{w.path}</span>
                        </span>
                        <Copy className="h-3 w-3 shrink-0 text-foreground/30 opacity-0 transition-opacity group-hover:opacity-100" />
                      </motion.button>
                    )
                  })}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {info?.dirty && (
        <span
          title={t('git.dirty')}
          aria-label={t('git.dirty')}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-warning"
        />
      )}
      {info?.lastCommit && (
        <span className="min-w-0 flex-1 truncate" title={`${info.lastCommit.hash} · ${info.lastCommit.subject}`}>
          <span className="font-mono text-foreground/40">{info.lastCommit.hash}</span>
          {' · '}
          {info.lastCommit.subject}
        </span>
      )}
    </div>
  )
}
