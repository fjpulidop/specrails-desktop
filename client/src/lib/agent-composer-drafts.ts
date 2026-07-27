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

export const NEW_MISSION_DRAFT_KEY = '__new-mission__'

export const composerDrafts = new Map<string, string>()
export const composerAttachmentDrafts = new Map<string, AgentAttachment[]>()

/**
 * Move the empty-compose-screen drafts (text + attachment chips) to a freshly
 * materialized conversation id. Idempotent — the new-mission slots are cleared
 * on first migration, so racing callers (context migrate + the composer's own
 * adoption paths) can both run safely.
 */
export function migrateNewMissionComposerDrafts(conversationId: string): void {
  const prompt = composerDrafts.get(NEW_MISSION_DRAFT_KEY)
  if (prompt !== undefined) {
    if (!composerDrafts.has(conversationId)) composerDrafts.set(conversationId, prompt)
    composerDrafts.delete(NEW_MISSION_DRAFT_KEY)
  }
  const attachments = composerAttachmentDrafts.get(NEW_MISSION_DRAFT_KEY)
  if (attachments?.length) {
    const existing = composerAttachmentDrafts.get(conversationId) ?? []
    composerAttachmentDrafts.set(conversationId, [...existing, ...attachments])
    composerAttachmentDrafts.delete(NEW_MISSION_DRAFT_KEY)
  }
}

/** Test-only: reset the session draft store between cases. */
export function __clearComposerDrafts(): void {
  composerDrafts.clear()
  composerAttachmentDrafts.clear()
}
