import { useCallback, useEffect, useRef, useState } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { getApiBase } from '../../../lib/api'
import {
  SPEC_DRAFT_DEFAULTS,
  SPEC_DRAFT_FIELDS,
  isSpecDraftUpdate,
  type SpecDraft,
  type SpecDraftField,
} from '../lib/spec-draft'

export interface UseSpecDraftStreamResult {
  draft: SpecDraft
  ready: boolean
  chips: string[]
  /** Field keys that changed in the most recent Claude-driven merge (for flash animation). */
  lastChangedFields: SpecDraftField[]
  /** True while the user is mid-typing in the composer between turns. */
  hasManualOverrides: boolean
  /** Apply a manual user edit to a single field. Records the field as overridden. */
  setField: <K extends SpecDraftField>(key: K, value: SpecDraft[K]) => void
  /** Called when the user sends a message — clears manual override tracking so the next Claude turn is authoritative. */
  clearManualOverrides: () => void
}

export function useSpecDraftStream(
  conversationId: string | null,
  /** Optional initial draft used both as `useState` init AND as the value the
   *  conversation-change reset effect restores to. When provided, the keys
   *  carried in the initial draft are marked as manual overrides so server
   *  hydration / WS pushes don't blow them away. Used by edit-existing-ticket
   *  mode to pre-fill the draft pane from the ticket. */
  initialDraft?: Partial<SpecDraft>,
): UseSpecDraftStreamResult {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  // Build the effective initial state once: defaults + overrides from
  // initialDraft. Keys present in initialDraft mark as manual on init.
  const initialKeysRef = useRef<SpecDraftField[]>(
    initialDraft
      ? (Object.keys(initialDraft) as SpecDraftField[]).filter(
          (k) => (initialDraft as Partial<SpecDraft>)[k] !== undefined,
        )
      : [],
  )
  const initialMergedRef = useRef<SpecDraft>({ ...SPEC_DRAFT_DEFAULTS, ...(initialDraft ?? {}) })
  const [draft, setDraft] = useState<SpecDraft>(initialMergedRef.current)
  const [ready, setReady] = useState(false)
  const [chips, setChips] = useState<string[]>([])
  const [lastChangedFields, setLastChangedFields] = useState<SpecDraftField[]>([])
  const manualFieldsRef = useRef<Set<SpecDraftField>>(new Set(initialKeysRef.current))
  const [hasManualOverrides, setHasManualOverrides] = useState(initialKeysRef.current.length > 0)

  // Reset state when conversation changes, then hydrate any draft state
  // the server has accumulated for this conversation. Covers the case
  // where Claude pushed `spec_draft.update` events while no shell was
  // subscribed (refresh during streaming, restored from a minimized chip).
  // Manual overrides from the user (replayed via setField after this
  // mount) win over server values — the merge guard checks `manual`
  // before overwriting, mirroring the WS handler logic below.
  useEffect(() => {
    setDraft(initialMergedRef.current)
    setReady(false)
    setChips([])
    setLastChangedFields([])
    manualFieldsRef.current = new Set(initialKeysRef.current)
    setHasManualOverrides(initialKeysRef.current.length > 0)
    if (!conversationId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${getApiBase()}/chat/conversations/${conversationId}/spec-draft`)
        if (!res.ok) return
        const data = (await res.json()) as { draft: Partial<SpecDraft> | null; ready: boolean; chips: string[] }
        if (cancelled) return
        if (!data.draft) return
        const manual = manualFieldsRef.current
        setDraft((prev) => {
          const next: SpecDraft = { ...prev }
          for (const key of SPEC_DRAFT_FIELDS) {
            if (manual.has(key)) continue
            const incoming = (data.draft as Partial<SpecDraft>)[key]
            if (incoming === undefined) continue
            ;(next as unknown as Record<SpecDraftField, unknown>)[key] = incoming
          }
          return next
        })
        setReady(data.ready)
        setChips(data.chips.slice(0, 3))
      } catch {
        /* network errors are non-fatal — WS will catch up on next turn */
      }
    })()
    return () => { cancelled = true }
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    const handlerId = `spec-draft-stream:${conversationId}`
    registerHandler(handlerId, (msg) => {
      if (!isSpecDraftUpdate(msg)) return
      if (msg.conversationId !== conversationId) return

      const manual = manualFieldsRef.current
      const changedThisTurn: SpecDraftField[] = []

      setDraft((prev) => {
        const next: SpecDraft = { ...prev }
        for (const key of SPEC_DRAFT_FIELDS) {
          if (manual.has(key)) continue
          const incoming = (msg.draft as Partial<SpecDraft>)[key]
          if (incoming === undefined) continue
          // Only mark as changed if the value differs.
          const changed = !shallowEqualField(next[key], incoming)
          ;(next as unknown as Record<SpecDraftField, unknown>)[key] = incoming
          if (changed) changedThisTurn.push(key)
        }
        return next
      })

      setReady(msg.ready)
      setChips(msg.chips.slice(0, 3))
      setLastChangedFields(changedThisTurn)
    })
    return () => unregisterHandler(handlerId)
  }, [conversationId, registerHandler, unregisterHandler])

  const setField: UseSpecDraftStreamResult['setField'] = useCallback((key, value) => {
    manualFieldsRef.current.add(key)
    setHasManualOverrides(true)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }, [])

  const clearManualOverrides = useCallback(() => {
    if (manualFieldsRef.current.size === 0) return
    manualFieldsRef.current = new Set()
    setHasManualOverrides(false)
  }, [])

  return {
    draft,
    ready,
    chips,
    lastChangedFields,
    hasManualOverrides,
    setField,
    clearManualOverrides,
  }
}

function shallowEqualField(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}
