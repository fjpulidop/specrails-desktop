// Session-scoped composer draft store (design D15 — context/session state,
// never the URL): the Mission⇄Board mode switch UNMOUNTS the composer, so a
// typed-but-unsent prompt must survive outside component state. Keyed per
// conversation; the EMPTY "new mission" compose screen shares one draft slot.
//
// Lives in lib/ (not inside AgentComposer) because BOTH the composer and
// `AgentChatContext.materializeDraftConversation` need it: when a draft mission
// materializes from OUTSIDE the composer (e.g. a browser capture on the empty
// compose screen), the context migrates the new-mission drafts to the real
// conversation id BEFORE it flips `active`, so the composer's restore effect
// finds them under the new key and the typed text is never visually lost.

import { useSyncExternalStore } from 'react'
import type { AgentAttachment } from './agent-api'
import type { AgentContextChip } from './agent-context-palette'

/** Offsets refer to the plain text in the matching composerDrafts entry. */
export interface AgentComposerReferenceDraft {
  key: string
  start: number
  end: number
  chip: AgentContextChip
}

export const NEW_MISSION_DRAFT_KEY = '__new-mission__'

export const composerDrafts = new Map<string, string>()
export const composerAttachmentDrafts = new Map<string, AgentAttachment[]>()
export const composerReferenceDrafts = new Map<string, AgentComposerReferenceDraft[]>()
/** Stable admission key for retrying the same input after an uncertain HTTP result. */
export const composerSubmissionIds = new Map<string, { signature: string; queueId: string }>()

// ── Change notification ──────────────────────────────────────────────────────
// The composer UNMOUNTS mid-flight (Mission⇄Board, the EMPTY→ACTIVE branch swap
// in AgentModeSurface, the `active?.id` remount key in AgentConversationView),
// so a mutation is frequently issued by an instance that is already gone. The
// store is therefore the single source of truth and every mounted composer
// SUBSCRIBES to it: the snapshot is a per-key revision NUMBER (stable by
// construction — no array/string identity to churn `useSyncExternalStore`), and
// components read the actual values out of the maps while rendering.
const listeners = new Set<() => void>()
const revisions = new Map<string, number>()

function notifyComposerDraft(conversationId: string): void {
  revisions.set(conversationId, (revisions.get(conversationId) ?? 0) + 1)
  listeners.forEach((listener) => listener())
}

export function subscribeComposerDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Per-key revision: the stable snapshot the composer subscription reads. */
export function composerDraftRevision(conversationId: string): number {
  return revisions.get(conversationId) ?? 0
}

/** Re-render this composer whenever ITS draft key changes in the store. */
export function useComposerDraftRevision(conversationId: string): number {
  return useSyncExternalStore(
    subscribeComposerDrafts,
    () => composerDraftRevision(conversationId),
    () => composerDraftRevision(conversationId),
  )
}

/** The keystroke write: text + the reference spans that belong to that exact text. */
export function writeComposerDraft(conversationId: string, text: string, references: AgentComposerReferenceDraft[]): void {
  if (text) composerDrafts.set(conversationId, text)
  else composerDrafts.delete(conversationId)
  if (text && references.length) composerReferenceDrafts.set(conversationId, references)
  else composerReferenceDrafts.delete(conversationId)
  persistComposerDraft(conversationId)
  notifyComposerDraft(conversationId)
}

export function setComposerAttachments(conversationId: string, next: AgentAttachment[]): void {
  if (next.length > 0) composerAttachmentDrafts.set(conversationId, next)
  else composerAttachmentDrafts.delete(conversationId)
  persistComposerDraft(conversationId)
  notifyComposerDraft(conversationId)
}

/** Retry identity is durable bookkeeping, never rendered — it must not re-render. */
export function setComposerSubmission(conversationId: string, submission: { signature: string; queueId: string } | null): void {
  if (submission) composerSubmissionIds.set(conversationId, submission)
  else composerSubmissionIds.delete(conversationId)
  persistComposerDraft(conversationId)
}

function sameSubmittedPayload(conversationId: string, submitted: AgentComposerDraftSnapshot): boolean {
  return (composerDrafts.get(conversationId) ?? '') === submitted.text
    && JSON.stringify(composerReferenceDrafts.get(conversationId) ?? []) === JSON.stringify(submitted.references)
    && JSON.stringify((composerAttachmentDrafts.get(conversationId) ?? []).map((item) => item.id)) === JSON.stringify(submitted.attachments.map((item) => item.id))
}

function slotIsEmpty(conversationId: string): boolean {
  return !composerDrafts.get(conversationId)
    && !(composerReferenceDrafts.get(conversationId) ?? []).length
    && !(composerAttachmentDrafts.get(conversationId) ?? []).length
}

/**
 * Clear the draft a turn was submitted from — but ONLY while the slot still
 * holds that exact payload. Typing the next prompt (or switching missions)
 * during an in-flight send must never be erased by the previous send's
 * bookkeeping. Returns whether anything was cleared.
 */
export function clearSubmittedComposerDraft(conversationId: string, submitted: AgentComposerDraftSnapshot): boolean {
  if (!sameSubmittedPayload(conversationId, submitted)) return false
  composerDrafts.delete(conversationId)
  composerReferenceDrafts.delete(conversationId)
  composerAttachmentDrafts.delete(conversationId)
  clearComposerDraftRecovery(conversationId)
  notifyComposerDraft(conversationId)
  return true
}

/**
 * Give a rejected turn's work back, with the submission identity that keeps a
 * retry idempotent server-side. Refuses to overwrite a NEWER draft the user
 * typed while the send was in flight (that work wins).
 */
export function restoreSubmittedComposerDraft(conversationId: string, submitted: AgentComposerDraftSnapshot): boolean {
  if (!slotIsEmpty(conversationId) && !sameSubmittedPayload(conversationId, submitted)) return false
  restoreComposerDraft(conversationId, submitted)
  return true
}

/** Plain, transferable input; uploaded attachment descriptors contain no file bytes. */
export interface AgentComposerDraftSnapshot {
  text: string
  references: AgentComposerReferenceDraft[]
  attachments: AgentAttachment[]
  submission?: { signature: string; queueId: string }
}

const RECOVERY_PREFIX = 'specrails:mission-draft:v1:'
const MAX_RECOVERY_BYTES = 2 * 1024 * 1024

function cloneDraft(draft: AgentComposerDraftSnapshot): AgentComposerDraftSnapshot {
  return JSON.parse(JSON.stringify(draft)) as AgentComposerDraftSnapshot
}

/** Capture copies rather than sharing chip objects between a live editor and a handoff. */
export function captureComposerDraft(conversationId: string): AgentComposerDraftSnapshot {
  return cloneDraft({
    text: composerDrafts.get(conversationId) ?? '',
    references: composerReferenceDrafts.get(conversationId) ?? [],
    attachments: composerAttachmentDrafts.get(conversationId) ?? [],
    ...(composerSubmissionIds.has(conversationId) ? { submission: composerSubmissionIds.get(conversationId) } : {}),
  })
}

export function hasComposerDraft(conversationId: string): boolean {
  return composerDrafts.has(conversationId) || composerReferenceDrafts.has(conversationId) || composerAttachmentDrafts.has(conversationId) || composerSubmissionIds.has(conversationId)
}

/** Restore text and its exact reference positions as one operation. */
export function restoreComposerDraft(conversationId: string, draft: AgentComposerDraftSnapshot): void {
  const copy = cloneDraft(draft)
  composerDrafts.set(conversationId, copy.text)
  composerReferenceDrafts.set(conversationId, copy.references)
  composerAttachmentDrafts.set(conversationId, copy.attachments)
  if (copy.submission) composerSubmissionIds.set(conversationId, copy.submission)
  else composerSubmissionIds.delete(conversationId)
  persistComposerDraft(conversationId)
  notifyComposerDraft(conversationId)
}

/** A session copy is recovery only: it never broadcasts edits into another window. */
export function persistComposerDraft(conversationId: string): boolean {
  try {
    const value = JSON.stringify({ version: 1, ...captureComposerDraft(conversationId) })
    if (new TextEncoder().encode(value).length > MAX_RECOVERY_BYTES) return false
    sessionStorage.setItem(RECOVERY_PREFIX + encodeURIComponent(conversationId), value)
    return true
  } catch { return false }
}

export function recoverComposerDraft(conversationId: string): boolean {
  if (hasComposerDraft(conversationId)) return true
  try {
    const raw = sessionStorage.getItem(RECOVERY_PREFIX + encodeURIComponent(conversationId))
    if (!raw || raw.length > MAX_RECOVERY_BYTES) return false
    const value = JSON.parse(raw) as Partial<AgentComposerDraftSnapshot> & { version?: number }
    if (value.version !== 1 || typeof value.text !== 'string' || !Array.isArray(value.references) || !Array.isArray(value.attachments)) return false
    if (!value.references.every(ref => typeof ref?.key === 'string' && Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 0 && ref.end >= ref.start && ref.end <= value.text!.length && typeof ref.chip?.id === 'string')) return false
    if (!value.attachments.every(att => typeof att?.id === 'string' && typeof att.filename === 'string')) return false
    if (value.submission !== undefined && (!value.submission || typeof value.submission.signature !== 'string' || typeof value.submission.queueId !== 'string' || !value.submission.queueId)) return false
    restoreComposerDraft(conversationId, value as AgentComposerDraftSnapshot)
    return true
  } catch { return false }
}

export function clearComposerDraftRecovery(conversationId: string): void {
  try { sessionStorage.removeItem(RECOVERY_PREFIX + encodeURIComponent(conversationId)) } catch { /* storage unavailable */ }
}

/**
 * Move the empty-compose-screen drafts (text, inline references and attachments) to a freshly
 * materialized conversation id. Idempotent — the new-mission slots are cleared
 * on first migration, so racing callers (context migrate + the composer's own
 * adoption paths) can both run safely.
 */
export function migrateNewMissionComposerDrafts(conversationId: string): void {
  const prompt = composerDrafts.get(NEW_MISSION_DRAFT_KEY)
  const references = composerReferenceDrafts.get(NEW_MISSION_DRAFT_KEY)
  const submission = composerSubmissionIds.get(NEW_MISSION_DRAFT_KEY)
  if (prompt !== undefined) {
    const existingPrompt = composerDrafts.get(conversationId)
    if (submission && !composerSubmissionIds.has(conversationId) && (existingPrompt === undefined || existingPrompt === prompt)) composerSubmissionIds.set(conversationId, { ...submission })
    if (existingPrompt === undefined) {
      composerDrafts.set(conversationId, prompt)
      // The positions belong to this exact prompt. Replace orphaned destination
      // references instead of attaching them to newly adopted text.
      if (references !== undefined) composerReferenceDrafts.set(conversationId, references)
      else composerReferenceDrafts.delete(conversationId)
    } else if (existingPrompt === prompt && !composerReferenceDrafts.has(conversationId) && references !== undefined) {
      composerReferenceDrafts.set(conversationId, references)
    }
    composerDrafts.delete(NEW_MISSION_DRAFT_KEY)
  }
  // Never transfer references without their text, or merge spans into a
  // different destination draft. Both cases would silently reference the wrong
  // words after a new mission materializes.
  composerReferenceDrafts.delete(NEW_MISSION_DRAFT_KEY)
  composerSubmissionIds.delete(NEW_MISSION_DRAFT_KEY)
  const attachments = composerAttachmentDrafts.get(NEW_MISSION_DRAFT_KEY)
  if (attachments !== undefined) {
    if (attachments.length) {
      const existing = composerAttachmentDrafts.get(conversationId) ?? []
      composerAttachmentDrafts.set(conversationId, [...existing, ...attachments])
    }
    composerAttachmentDrafts.delete(NEW_MISSION_DRAFT_KEY)
  }
  clearComposerDraftRecovery(NEW_MISSION_DRAFT_KEY)
  if (hasComposerDraft(conversationId)) persistComposerDraft(conversationId)
  notifyComposerDraft(NEW_MISSION_DRAFT_KEY)
  notifyComposerDraft(conversationId)
}

/** Test-only: reset the session draft store between cases. */
export function __clearComposerDrafts(): void {
  composerDrafts.clear()
  composerAttachmentDrafts.clear()
  composerReferenceDrafts.clear()
  composerSubmissionIds.clear()
  revisions.clear()
  listeners.clear()
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i))
    for (const key of keys) if (key?.startsWith(RECOVERY_PREFIX)) sessionStorage.removeItem(key)
  } catch { /* storage unavailable */ }
}
