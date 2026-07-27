import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAttachment } from '../agent-api'
import {
  NEW_MISSION_DRAFT_KEY,
  composerDrafts,
  composerAttachmentDrafts,
  migrateNewMissionComposerDrafts,
  __clearComposerDrafts,
} from '../agent-composer-drafts'

const att = (id: string): AgentAttachment => ({ id, filename: `${id}.png`, mimeType: 'image/png', size: 10 } as AgentAttachment)

afterEach(() => {
  __clearComposerDrafts()
})

describe('migrateNewMissionComposerDrafts', () => {
  it('moves the new-mission text and attachments to the conversation id', () => {
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'typed draft')
    composerAttachmentDrafts.set(NEW_MISSION_DRAFT_KEY, [att('a1')])

    migrateNewMissionComposerDrafts('c1')

    expect(composerDrafts.get('c1')).toBe('typed draft')
    expect(composerDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
    expect(composerAttachmentDrafts.get('c1')?.map((a) => a.id)).toEqual(['a1'])
    expect(composerAttachmentDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
  })

  it('never overwrites an existing conversation text draft and appends attachments', () => {
    composerDrafts.set('c1', 'existing')
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'new-mission text')
    composerAttachmentDrafts.set('c1', [att('a0')])
    composerAttachmentDrafts.set(NEW_MISSION_DRAFT_KEY, [att('a1')])

    migrateNewMissionComposerDrafts('c1')

    expect(composerDrafts.get('c1')).toBe('existing')
    expect(composerAttachmentDrafts.get('c1')?.map((a) => a.id)).toEqual(['a0', 'a1'])
  })

  it('is idempotent — a second migration is a no-op', () => {
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'text')
    composerAttachmentDrafts.set(NEW_MISSION_DRAFT_KEY, [att('a1')])
    migrateNewMissionComposerDrafts('c1')
    migrateNewMissionComposerDrafts('c2')

    expect(composerDrafts.has('c2')).toBe(false)
    expect(composerAttachmentDrafts.has('c2')).toBe(false)
    expect(composerDrafts.get('c1')).toBe('text')
  })

  it('does nothing when there are no new-mission drafts', () => {
    migrateNewMissionComposerDrafts('c1')
    expect(composerDrafts.size).toBe(0)
    expect(composerAttachmentDrafts.size).toBe(0)
  })
})
