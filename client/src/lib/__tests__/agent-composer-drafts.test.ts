import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAttachment } from '../agent-api'
import {
  NEW_MISSION_DRAFT_KEY,
  composerDrafts,
  composerAttachmentDrafts,
  composerReferenceDrafts,
  type AgentComposerReferenceDraft,
  migrateNewMissionComposerDrafts,
  __clearComposerDrafts,
} from '../agent-composer-drafts'

const att = (id: string): AgentAttachment => ({ id, filename: `${id}.png`, mimeType: 'image/png', size: 10 } as AgentAttachment)
const ref = (id = '1', start = 17): AgentComposerReferenceDraft => ({
  key: `spec-${id}`,
  start,
  end: start + id.length + 1,
  chip: { kind: 'spec', id, label: `Spec ${id}`, token: `#${id}`, projectId: 'p1' },
})

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
    expect(composerReferenceDrafts.size).toBe(0)
  })

  it('moves inline references with their text and preserves their insertion positions', () => {
    const prompt = 'implementemos el #1 después'
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, prompt)
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [ref()])

    migrateNewMissionComposerDrafts('c1')

    const [reference] = composerReferenceDrafts.get('c1')!
    expect(composerDrafts.get('c1')?.slice(reference.start, reference.end)).toBe('#1')
    expect(reference.chip.projectId).toBe('p1')
    expect(composerReferenceDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)

    migrateNewMissionComposerDrafts('c2')
    expect(composerReferenceDrafts.has('c2')).toBe(false)
    expect(composerReferenceDrafts.get('c1')).toEqual([ref()])
  })

  it('keeps destination references when its text differs from the new mission', () => {
    composerDrafts.set('c1', '#2 revise this')
    composerReferenceDrafts.set('c1', [ref('2', 0)])
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'implementemos el #1')
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [ref()])

    migrateNewMissionComposerDrafts('c1')

    expect(composerDrafts.get('c1')).toBe('#2 revise this')
    expect(composerReferenceDrafts.get('c1')).toEqual([ref('2', 0)])
    expect(composerReferenceDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
  })

  it('does not attach references to conflicting destination text with no references', () => {
    composerDrafts.set('c1', 'keep this text')
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'implementemos el #1')
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [ref()])

    migrateNewMissionComposerDrafts('c1')

    expect(composerReferenceDrafts.has('c1')).toBe(false)
    expect(composerReferenceDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
  })

  it('recovers references if another caller already adopted the same text', () => {
    composerDrafts.set('c1', 'implementemos el #1')
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'implementemos el #1')
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [ref()])

    migrateNewMissionComposerDrafts('c1')

    expect(composerReferenceDrafts.get('c1')).toEqual([ref()])
  })

  it('does not merge or replace destination references for the same text', () => {
    const destinationReference = { ...ref(), key: 'destination', chip: { ...ref().chip, projectId: 'p2' } }
    composerDrafts.set('c1', 'implementemos el #1')
    composerReferenceDrafts.set('c1', [destinationReference])
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'implementemos el #1')
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [ref()])

    migrateNewMissionComposerDrafts('c1')

    expect(composerReferenceDrafts.get('c1')).toEqual([destinationReference])
  })

  it('removes orphaned destination references when adopting a plain-text source', () => {
    composerReferenceDrafts.set('c1', [ref()])
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'plain text')

    migrateNewMissionComposerDrafts('c1')

    expect(composerDrafts.get('c1')).toBe('plain text')
    expect(composerReferenceDrafts.has('c1')).toBe(false)
  })

  it('discards source references without a matching source text draft', () => {
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [ref()])

    migrateNewMissionComposerDrafts('c1')

    expect(composerDrafts.has('c1')).toBe(false)
    expect(composerReferenceDrafts.size).toBe(0)
  })

  it('clears empty new-mission slots during materialization', () => {
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, '')
    composerReferenceDrafts.set(NEW_MISSION_DRAFT_KEY, [])
    composerAttachmentDrafts.set(NEW_MISSION_DRAFT_KEY, [])

    migrateNewMissionComposerDrafts('c1')

    expect(composerDrafts.get('c1')).toBe('')
    expect(composerReferenceDrafts.get('c1')).toEqual([])
    expect(composerReferenceDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
    expect(composerAttachmentDrafts.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
  })

  it('clears persisted inline references with the other composer drafts', () => {
    composerDrafts.set('c1', 'implementemos el #1')
    composerReferenceDrafts.set('c1', [ref()])
    composerAttachmentDrafts.set('c1', [att('a1')])

    __clearComposerDrafts()

    expect(composerDrafts.size).toBe(0)
    expect(composerReferenceDrafts.size).toBe(0)
    expect(composerAttachmentDrafts.size).toBe(0)
  })
})
