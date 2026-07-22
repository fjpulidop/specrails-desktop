import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useDesktop } from '../hooks/useDesktop'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { isSpecDraftUpdate } from '../lib/spec-draft'
import { MinimizedChatsDock } from '../components/minimized-chats/MinimizedChatsDock'

// ─── Types ────────────────────────────────────────────────────────────────

export type MinimizedChatKind = 'explore-spec' | 'ai-edit'

export interface ExploreSpecParams {
  initialIdea: string
  pendingSpecId: string
  initialAttachmentIds: string[]
  /** Server-side conversation id captured when the shell minimized — used on
   *  restore to rehydrate via existing chat APIs instead of bootstrapping a
   *  fresh `/specrails:explore-spec` turn. */
  resumeConversationId?: string
  /** In-progress composer text the user was typing when they minimized.
   *  Replayed into the editor on restore so a half-typed reply isn't lost. */
  composerText?: string
  /** Manual draft field overrides (title/description/labels/priority/criteria)
   *  the user applied before minimize. Replayed via `setField` on restore so
   *  edits survive the cycle. */
  draftOverrides?: {
    title?: string
    description?: string
    priority?: 'low' | 'medium' | 'high' | 'critical'
    labels?: string[]
    acceptanceCriteria?: string[]
  }
  /** When set, the shell is launched in edit-existing-ticket mode. The shell
   *  pre-seeds the draft from this payload, uses it as the Review baseline,
   *  and commits via PATCH /tickets/:id. See
   *  openspec/changes/replace-ai-edit-with-continue-editing/design.md D2. */
  editTicket?: {
    id: number
    title: string
    description: string
    labels: string[]
    priority: 'low' | 'medium' | 'high' | 'critical' | null
    acceptanceCriteria: string[]
    /** Current ticket status. `'draft'` makes the shell PUBLISH on commit
     *  (flip draft → real spec) instead of PATCHing in place. Optional for
     *  backward-compat; absent ⇒ treated as a real-spec edit. */
    status?: 'draft' | 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled'
  }
}

export interface AiEditParams {
  agentId: string
  baseBody: string
  /** Server-side refine session id — drives `useAgentRefine.rehydrate()` on
   *  restore so the draft, history and diff state come back from the server. */
  resumeRefineId?: string
}

interface MinimizedChatBase {
  id: string
  projectId: string
  label: string
  restoreRoute: string
  createdAt: number
}

export type MinimizedChat =
  | (MinimizedChatBase & { kind: 'explore-spec'; params: ExploreSpecParams })
  | (MinimizedChatBase & { kind: 'ai-edit'; params: AiEditParams })

interface MinimizedChatsContextValue {
  chats: MinimizedChat[]
  /** Pending restores — exposed so `usePendingRestore` can react to changes.
   *  Triggers MUST consume via `takePendingRestore`, not by reading this.
   *  Surfaces that only want to know "is a restore in flight for me" (e.g.
   *  AgentsPage switching to the Catalog tab) MAY read it. */
  pendingRestores: MinimizedChat[]
  /** Park a new minimized session and add it to the dock. Returns its id. */
  minimize: (input: Omit<MinimizedChat, 'id' | 'createdAt'>) => string
  /** Update a parked chat's display label live (e.g. when the underlying
   *  conversation gets a fresh draft title from Claude). No-op if id
   *  is not in the minimized list. */
  updateLabel: (id: string, label: string) => void
  /** Merge live spec-draft fields (description, labels, priority,
   *  acceptanceCriteria) into a parked explore-spec chat's params so that
   *  values Claude pushes WHILE the shell is minimized survive even if
   *  the server's in-memory `_specDraftStates` is later wiped (e.g. dev
   *  server restart). No-op for non-explore-spec chats. */
  patchExploreSpecDraft: (
    id: string,
    patch: Partial<NonNullable<ExploreSpecParams['draftOverrides']>>,
  ) => void
  /** Drop a chip silently. */
  close: (id: string) => void
  /** Switch project, navigate to restore route, and queue a pending-restore
   *  the matching trigger picks up via `usePendingRestore`. */
  restore: (id: string) => void
  /** Trigger-side: returns the next pending restore matching (kind,
   *  projectId), or null. Internally consumes on call. */
  takePendingRestore: (
    kind: MinimizedChatKind,
    projectId: string,
  ) => MinimizedChat | null
  /** Push a session into the pending-restore queue WITHOUT first parking it as
   *  a minimized chip. Used by surfaces that want to open a shell from a
   *  durable record (e.g. a draft ticket's Continue Explore button). */
  triggerResume: (input: Omit<MinimizedChat, 'id' | 'createdAt'>) => void
}

const MinimizedChatsContext = createContext<MinimizedChatsContextValue | null>(
  null,
)

// ─── Persistence ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'specrails-desktop:minimized-chats'
// Pending restores are persisted too, so a refresh that lands BETWEEN a chip
// click and the trigger consuming it never loses the session — on next mount
// any leftover pending entry is folded back into the dock.
const PENDING_STORAGE_KEY = 'specrails-desktop:minimized-chats-pending'
const MAX_PERSISTED = 50
// If a queued restore is not consumed within this window (e.g. the trigger
// surface never mounts), the chip is moved back into the dock so the session
// can never be silently lost.
const RESTORE_WATCHDOG_MS = 8000

export function loadFromStorage(): MinimizedChat[] {
  return readChatList(STORAGE_KEY)
}

export function saveToStorage(chats: MinimizedChat[]): void {
  writeChatList(STORAGE_KEY, chats)
}

function loadPendingFromStorage(): MinimizedChat[] {
  return readChatList(PENDING_STORAGE_KEY)
}

function savePendingToStorage(chats: MinimizedChat[]): void {
  writeChatList(PENDING_STORAGE_KEY, chats)
}

function readChatList(key: string): MinimizedChat[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidChat)
  } catch {
    return []
  }
}

// B25: cap the chat list (drop oldest first). Applied to BOTH the in-memory dock
// state and the persisted copy, so they never diverge — previously the cap lived
// only here (persistence), so the in-memory dock could hold >MAX_PERSISTED chips
// and the extras vanished silently on the next refresh.
function capChats(chats: MinimizedChat[]): MinimizedChat[] {
  if (chats.length <= MAX_PERSISTED) return chats
  return [...chats].sort((a, b) => a.createdAt - b.createdAt).slice(chats.length - MAX_PERSISTED)
}

function writeChatList(key: string, chats: MinimizedChat[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(capChats(chats)))
  } catch {
    /* quota or storage unavailable — silent */
  }
}

function isValidChat(value: unknown): value is MinimizedChat {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if (typeof c.id !== 'string') return false
  if (typeof c.projectId !== 'string') return false
  if (typeof c.label !== 'string') return false
  if (typeof c.restoreRoute !== 'string') return false
  if (typeof c.createdAt !== 'number') return false
  if (c.kind !== 'explore-spec' && c.kind !== 'ai-edit') return false
  if (!c.params || typeof c.params !== 'object') return false
  return true
}

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Stable identity of the underlying server session behind a chip. Two chips
 *  with the same key represent the SAME session and must never coexist
 *  (re-parking would otherwise duplicate it forever). Falls back to the
 *  client-stable handle (`pendingSpecId` / `agentId`) when the server session
 *  id hasn't been assigned yet, so even a FRESH session deduplicates across
 *  re-parks — `pendingSpecId` is unique per Explore launch and `agentId` is
 *  unique per AI-Edit target, so distinct sessions never collide. */
function sessionKey(c: MinimizedChat): string {
  if (c.kind === 'explore-spec') {
    return c.params.resumeConversationId ?? `pending:${c.params.pendingSpecId}`
  }
  return c.params.resumeRefineId ?? `agent:${c.params.agentId}`
}

function sameSession(a: MinimizedChat, b: MinimizedChat): boolean {
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false
  return sessionKey(a) === sessionKey(b)
}

// ─── Provider ─────────────────────────────────────────────────────────────

export function MinimizedChatsProvider({ children }: { children: ReactNode }) {
  const { projects, activeProjectId, setActiveProjectId } = useDesktop()
  const navigate = useNavigate()
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const [chats, setChats] = useState<MinimizedChat[]>(() => loadFromStorage())
  // Pending restores live separately from `chats` so the chip is removed
  // from the dock immediately on click, but the trigger can still pick the
  // entry up after a project switch + remount. Persisted to localStorage so a
  // refresh mid-restore recovers instead of dropping the session.
  const [pendingRestores, setPendingRestores] = useState<MinimizedChat[]>([])

  // Synchronous snapshots — setState updaters can run asynchronously, so we
  // read latest state via refs when consumers need a synchronous answer.
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  const pendingRestoresRef = useRef(pendingRestores)
  pendingRestoresRef.current = pendingRestores

  // Per-pending-restore watchdog timers (id → timeout handle).
  const watchdogsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const projectsRef = useRef(projects)
  projectsRef.current = projects

  // Recover orphaned pending restores once on mount. A persisted pending entry
  // means a previous session queued a restore that was never consumed (the
  // trigger surface didn't mount, or the tab refreshed mid-restore). Fold them
  // back into the dock so the session is never lost, then clear the store.
  const recoveredRef = useRef(false)
  useEffect(() => {
    if (recoveredRef.current) return
    recoveredRef.current = true
    const orphans = loadPendingFromStorage()
    savePendingToStorage([])
    if (orphans.length === 0) return
    setChats((prev) => {
      const merged = [...prev]
      for (const o of orphans) {
        if (merged.some((c) => c.id === o.id || sameSession(c, o))) continue
        merged.push(o)
      }
      saveToStorage(merged)
      chatsRef.current = merged
      return merged
    })
  }, [])

  // Clear all watchdogs on unmount.
  useEffect(() => {
    const timers = watchdogsRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  // Persist whenever either list changes (backstop — the mutators below also
  // write synchronously for durability against an immediate refresh).
  useEffect(() => {
    saveToStorage(chats)
  }, [chats])
  useEffect(() => {
    savePendingToStorage(pendingRestores)
  }, [pendingRestores])

  // Live-update parked explore-spec chats when Claude pushes
  // `spec_draft.update` — title hits the chip's label, the rest of the
  // fields land in the chip's `params.draftOverrides`. The latter matters
  // because it survives a server-restart-while-minimized: the restored
  // shell can fall back on the chip's own draft snapshot when the
  // server's in-memory `_specDraftStates` has been wiped. We use chatsRef
  // so the handler always reads the latest list without re-registering.
  const updateLabelRef = useRef<(id: string, label: string) => void>(() => {})
  const patchExploreSpecDraftRef = useRef<
    (id: string, patch: Partial<NonNullable<ExploreSpecParams['draftOverrides']>>) => void
  >(() => {})
  useEffect(() => {
    const handlerId = 'minimized-chats:spec-draft'
    registerHandler(handlerId, (msg) => {
      if (!isSpecDraftUpdate(msg)) return
      const conversationId = msg.conversationId
      const match = chatsRef.current.find(
        (c) =>
          c.kind === 'explore-spec' &&
          c.params.resumeConversationId === conversationId,
      )
      if (!match) return
      const incoming = msg.draft as Partial<{
        title: string
        description: string
        priority: 'low' | 'medium' | 'high' | 'critical'
        labels: string[]
        acceptanceCriteria: string[]
      }>
      if (incoming.title?.trim()) {
        updateLabelRef.current(match.id, incoming.title)
      }
      const patch: Partial<NonNullable<ExploreSpecParams['draftOverrides']>> = {}
      if (incoming.title !== undefined) patch.title = incoming.title
      if (incoming.description !== undefined) patch.description = incoming.description
      if (incoming.priority !== undefined) patch.priority = incoming.priority
      if (incoming.labels !== undefined) patch.labels = incoming.labels
      if (incoming.acceptanceCriteria !== undefined) patch.acceptanceCriteria = incoming.acceptanceCriteria
      if (Object.keys(patch).length > 0) {
        patchExploreSpecDraftRef.current(match.id, patch)
      }
    })
    return () => unregisterHandler(handlerId)
  }, [registerHandler, unregisterHandler])

  // Drop chips for projects that no longer exist (silent cleanup). Skips while
  // the project list is still loading (length 0) so a cold start never wipes
  // chips before the registry is known.
  useEffect(() => {
    if (projects.length === 0) return
    const existing = new Set(projects.map((p) => p.id))
    setChats((prev) => {
      const filtered = prev.filter((c) => existing.has(c.projectId))
      if (filtered.length === prev.length) return prev
      saveToStorage(filtered)
      chatsRef.current = filtered
      return filtered
    })
    setPendingRestores((prev) => {
      const next = prev.filter((c) => existing.has(c.projectId))
      if (next.length === prev.length) return prev
      savePendingToStorage(next)
      pendingRestoresRef.current = next
      return next
    })
  }, [projects])

  const minimize = useCallback(
    (input: Omit<MinimizedChat, 'id' | 'createdAt'>): string => {
      const id = genId()
      const chat = { ...input, id, createdAt: Date.now() } as MinimizedChat
      setChats((prev) => {
        // Dedupe: re-parking a session that already has a chip must replace it,
        // never stack a second chip for the same conversation.
        // B25: cap in memory too so the dock and localStorage stay in sync.
        const next = capChats([...prev.filter((c) => !sameSession(c, chat)), chat])
        // Synchronous durability — the caller (e.g. SpecsBoard) clears its own
        // active-session store right after this returns, so the chip must be in
        // localStorage BEFORE we yield, or an immediate refresh would lose it.
        saveToStorage(next)
        chatsRef.current = next
        return next
      })
      // Notify the server for Explore Spec lifecycle (idle-kill timer).
      // Best-effort; no UX dependency on success.
      if (input.kind === 'explore-spec') {
        const params = input.params as ExploreSpecParams
        const convId = params.resumeConversationId
        if (convId) {
          void fetch(
            `/api/projects/${input.projectId}/chat/conversations/${convId}/minimize`,
            { method: 'POST' },
          ).catch(() => { /* ignore */ })
        }
      }
      return id
    },
    [],
  )

  const clearWatchdog = useCallback((id: string) => {
    const t = watchdogsRef.current.get(id)
    if (t) {
      clearTimeout(t)
      watchdogsRef.current.delete(id)
    }
  }, [])

  const close = useCallback((id: string) => {
    clearWatchdog(id)
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== id)
      saveToStorage(next)
      chatsRef.current = next
      return next
    })
    setPendingRestores((prev) => {
      const next = prev.filter((c) => c.id !== id)
      if (next.length === prev.length) return prev
      savePendingToStorage(next)
      pendingRestoresRef.current = next
      return next
    })
  }, [clearWatchdog])

  const updateLabel = useCallback((id: string, label: string) => {
    const trimmed = label.trim()
    if (!trimmed) return
    setChats((prev) => {
      const next = prev.map((c) =>
        c.id === id && c.label !== trimmed ? { ...c, label: trimmed } : c,
      )
      if (next === prev) return prev
      chatsRef.current = next
      return next
    })
  }, [])

  const patchExploreSpecDraft = useCallback(
    (id: string, patch: Partial<NonNullable<ExploreSpecParams['draftOverrides']>>) => {
      setChats((prev) => {
        const next = prev.map((c) => {
          if (c.id !== id || c.kind !== 'explore-spec') return c
          const merged: NonNullable<ExploreSpecParams['draftOverrides']> = {
            ...(c.params.draftOverrides ?? {}),
            ...patch,
          }
          return { ...c, params: { ...c.params, draftOverrides: merged } }
        })
        chatsRef.current = next
        return next
      })
    },
    [],
  )

  const restore = useCallback(
    (id: string) => {
      const target = chatsRef.current.find((c) => c.id === id)
      if (!target) return
      // If the owning project was deleted (registry already loaded and the id
      // is gone), there is nowhere to restore into. Leave the chip in the dock
      // for the cleanup effect to remove on its own rather than optimistically
      // dropping it into a dead pending queue where it would vanish silently.
      const projectsLoaded = projectsRef.current.length > 0
      if (projectsLoaded && !projectsRef.current.some((p) => p.id === target.projectId)) {
        return
      }
      // Cancel the server-side idle-kill timer for Explore conversations.
      if (target.kind === 'explore-spec') {
        const params = target.params as ExploreSpecParams
        const convId = params.resumeConversationId
        if (convId) {
          void fetch(
            `/api/projects/${target.projectId}/chat/conversations/${convId}/restore`,
            { method: 'POST' },
          ).catch(() => { /* ignore */ })
        }
      }
      if (activeProjectId !== target.projectId) {
        setActiveProjectId(target.projectId)
      }
      navigate(target.restoreRoute)
      // Move chip → pending queue. Both writes are durable.
      setPendingRestores((prev) => {
        const next = [...prev.filter((c) => c.id !== id), target]
        savePendingToStorage(next)
        pendingRestoresRef.current = next
        return next
      })
      setChats((prev) => {
        const next = prev.filter((c) => c.id !== id)
        saveToStorage(next)
        chatsRef.current = next
        return next
      })
      // Watchdog: if nobody consumes this restore (trigger surface never
      // mounts), put the chip back so the session is never silently lost.
      clearWatchdog(id)
      const timer = setTimeout(() => {
        watchdogsRef.current.delete(id)
        if (!pendingRestoresRef.current.some((c) => c.id === id)) return
        setPendingRestores((prev) => {
          const next = prev.filter((c) => c.id !== id)
          savePendingToStorage(next)
          pendingRestoresRef.current = next
          return next
        })
        setChats((prev) => {
          if (prev.some((c) => c.id === id || sameSession(c, target))) return prev
          const next = [...prev, target]
          saveToStorage(next)
          chatsRef.current = next
          return next
        })
      }, RESTORE_WATCHDOG_MS)
      watchdogsRef.current.set(id, timer)
    },
    [activeProjectId, setActiveProjectId, navigate, clearWatchdog],
  )

  const restoreRef = useRef(restore)
  restoreRef.current = restore
  const closeRef = useRef(close)
  closeRef.current = close
  updateLabelRef.current = updateLabel
  patchExploreSpecDraftRef.current = patchExploreSpecDraft

  const takePendingRestore = useCallback(
    (kind: MinimizedChatKind, projectId: string): MinimizedChat | null => {
      const current = pendingRestoresRef.current
      const idx = current.findIndex(
        (c) => c.kind === kind && c.projectId === projectId,
      )
      if (idx === -1) return null
      const taken = current[idx]
      clearWatchdog(taken.id)
      // Functional update so a concurrent restore() (which appends) is never
      // clobbered by a stale snapshot.
      setPendingRestores((prev) => {
        const next = prev.filter((c) => c.id !== taken.id)
        savePendingToStorage(next)
        return next
      })
      pendingRestoresRef.current = current.filter((c) => c.id !== taken.id)
      return taken
    },
    [clearWatchdog],
  )

  const triggerResume = useCallback(
    (input: Omit<MinimizedChat, 'id' | 'createdAt'>) => {
      const id = genId()
      const chat = { ...input, id, createdAt: Date.now() } as MinimizedChat
      if (activeProjectId !== input.projectId) {
        setActiveProjectId(input.projectId)
      }
      navigate(input.restoreRoute)
      setPendingRestores((prev) => {
        const next = [...prev, chat]
        savePendingToStorage(next)
        pendingRestoresRef.current = next
        return next
      })
      // Watchdog parity with restore() — if the trigger never consumes the
      // resume, surface it in the dock rather than dropping it.
      clearWatchdog(id)
      const timer = setTimeout(() => {
        watchdogsRef.current.delete(id)
        if (!pendingRestoresRef.current.some((c) => c.id === id)) return
        setPendingRestores((prev) => {
          const next = prev.filter((c) => c.id !== id)
          savePendingToStorage(next)
          pendingRestoresRef.current = next
          return next
        })
        setChats((prev) => {
          if (prev.some((c) => c.id === id || sameSession(c, chat))) return prev
          const next = [...prev, chat]
          saveToStorage(next)
          chatsRef.current = next
          return next
        })
      }, RESTORE_WATCHDOG_MS)
      watchdogsRef.current.set(id, timer)
    },
    [activeProjectId, setActiveProjectId, navigate, clearWatchdog],
  )

  const value = useMemo<MinimizedChatsContextValue>(
    () => ({
      chats,
      pendingRestores,
      minimize,
      updateLabel,
      patchExploreSpecDraft,
      close,
      restore,
      takePendingRestore,
      triggerResume,
    }),
    [chats, pendingRestores, minimize, updateLabel, patchExploreSpecDraft, close, restore, takePendingRestore, triggerResume],
  )

  return (
    <MinimizedChatsContext.Provider value={value}>
      {children}
      <MinimizedChatsDock
        chats={chats}
        projects={projects}
        hidden={false}
        onRestore={restore}
        onClose={close}
      />
    </MinimizedChatsContext.Provider>
  )
}

// ─── Hooks ────────────────────────────────────────────────────────────────

export function useMinimizedChats(): MinimizedChatsContextValue {
  const ctx = useContext(MinimizedChatsContext)
  if (!ctx) {
    return {
      chats: [],
      pendingRestores: [],
      minimize: () => '',
      updateLabel: () => {},
      patchExploreSpecDraft: () => {},
      close: () => {},
      restore: () => {},
      takePendingRestore: () => null,
      triggerResume: () => {},
    }
  }
  return ctx
}

/** Trigger-side: subscribe to pending restores for a (kind, projectId) pair.
 *  The callback fires once per pending restore and the entry is consumed. */
export function usePendingRestore(
  kind: MinimizedChatKind,
  projectId: string | null,
  onRestore: (chat: MinimizedChat) => void,
): void {
  const { pendingRestores, takePendingRestore } = useMinimizedChats()
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore

  useEffect(() => {
    if (!projectId) return
    const pending = takePendingRestore(kind, projectId)
    if (pending) onRestoreRef.current(pending)
    // pendingRestores dep makes us re-check after any restore is queued so
    // a trigger remounting after a project switch still consumes its entry.
  }, [pendingRestores, kind, projectId, takePendingRestore])
}
