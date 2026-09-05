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

/**
 * Move the empty-compose-screen drafts (text, inline references and attachments) to a freshly
 * materialized conversation id. Idempotent — the new-mission slots are cleared
 * on first migration, so racing callers (context migrate + the composer's own
 * adoption paths) can both run safely.
 */
export function migrateNewMissionComposerDrafts(conversationId: string): void {
  const prompt = composerDrafts.get(NEW_MISSION_DRAFT_KEY)
  const references = composerReferenceDrafts.get(NEW_MISSION_DRAFT_KEY)
  if (prompt !== undefined) {
    const existingPrompt = composerDrafts.get(conversationId)
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
  const attachments = composerAttachmentDrafts.get(NEW_MISSION_DRAFT_KEY)
  if (attachments !== undefined) {
    if (attachments.length) {
      const existing = composerAttachmentDrafts.get(conversationId) ?? []
      composerAttachmentDrafts.set(conversationId, [...existing, ...attachments])
    }
    composerAttachmentDrafts.delete(NEW_MISSION_DRAFT_KEY)
  }
}

/** Test-only: reset the session draft store between cases. */
export function __clearComposerDrafts(): void {
  composerDrafts.clear()
  composerAttachmentDrafts.clear()
  composerReferenceDrafts.clear()
}
