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
  captureComposerDraft, restoreComposerDraft, persistComposerDraft, recoverComposerDraft, clearComposerDraftRecovery,
  composerSubmissionIds,
} from '../agent-composer-drafts'

const att = (id: string): AgentAttachment => ({ id, filename: `${id}.png`, mimeType: 'image/png', size: 10 } as AgentAttachment)
const ref = (id = '1', start = 17): AgentComposerReferenceDraft => ({
  key: `spec-${id}`,
  start,
  end: start + id.length + 1,
  chip: { kind: 'spec', id, label: `Spec ${id}`, token: `#${id}`, projectId: 'p1' },
})

describe('mission window draft recovery', () => {
  it('copies exact offsets and attachment metadata without sharing live objects', () => {
    const draft = { text: 'implementemos el #1', references: [ref()], attachments: [att('a1')] }
    restoreComposerDraft('c1', draft)
    draft.references[0].chip.label = 'mutated externally'
    const captured = captureComposerDraft('c1')
    expect(captured.references[0].chip.label).toBe('Spec 1')
    captured.references[0].start = 0
    expect(composerReferenceDrafts.get('c1')?.[0].start).toBe(17)
  })

  it('recovers a renderer reload but never replaces a newer in-memory draft', () => {
    restoreComposerDraft('c1', { text: 'saved', references: [], attachments: [att('a1')] })
    composerDrafts.clear(); composerAttachmentDrafts.clear(); composerReferenceDrafts.clear()
    expect(recoverComposerDraft('c1')).toBe(true)
    expect(captureComposerDraft('c1')).toEqual({ text: 'saved', references: [], attachments: [att('a1')] })
    composerDrafts.set('c1', 'newer')
    expect(recoverComposerDraft('c1')).toBe(true)
    expect(composerDrafts.get('c1')).toBe('newer')
  })

  it('persists a cleared draft so an old detached-window snapshot cannot resurrect a sent message', () => {
    restoreComposerDraft('c1', { text: 'sent now', references: [], attachments: [] })
    composerDrafts.delete('c1'); composerReferenceDrafts.delete('c1'); composerAttachmentDrafts.delete('c1')
    expect(persistComposerDraft('c1')).toBe(true)
    expect(recoverComposerDraft('c1')).toBe(true)
    expect(composerDrafts.get('c1')).toBe('')
  })

  it('rejects malformed/cross-position recovery and clears only the chosen mission', () => {
    restoreComposerDraft('c1', { text: 'one', references: [], attachments: [] })
    restoreComposerDraft('c2', { text: 'two', references: [], attachments: [] })
    clearComposerDraftRecovery('c1')
    composerDrafts.clear(); composerAttachmentDrafts.clear(); composerReferenceDrafts.clear()
    expect(recoverComposerDraft('c1')).toBe(false)
    expect(recoverComposerDraft('c2')).toBe(true)
    sessionStorage.setItem('specrails:mission-draft:v1:broken', JSON.stringify({ version: 1, text: 'tiny', references: [ref()], attachments: [] }))
    expect(recoverComposerDraft('broken')).toBe(false)
  })

  it('keeps oversized drafts usable in memory without silently truncating recovery', () => {
    composerDrafts.set('c1', '漢'.repeat(800_000))
    expect(persistComposerDraft('c1')).toBe(false)
    expect(composerDrafts.get('c1')).toHaveLength(800_000)
    expect(sessionStorage.getItem('specrails:mission-draft:v1:c1')).toBeNull()
  })

  it('carries uncertain-send identity through handoff and renderer reload, then clears it with the accepted draft', () => {
    const submission = { signature: '["pending",{}]', queueId: 'q-original-request' }
    restoreComposerDraft('c1', { text: 'pending', references: [], attachments: [], submission })
    expect(captureComposerDraft('c1').submission).toEqual(submission)
    composerDrafts.clear(); composerAttachmentDrafts.clear(); composerReferenceDrafts.clear(); composerSubmissionIds.clear()
    expect(recoverComposerDraft('c1')).toBe(true)
    expect(composerSubmissionIds.get('c1')).toEqual(submission)
    restoreComposerDraft('c1', { text: '', references: [], attachments: [] })
    expect(composerSubmissionIds.has('c1')).toBe(false)
  })

  it('migrates the new-mission retry identity only with its matching text', () => {
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'pending')
    composerSubmissionIds.set(NEW_MISSION_DRAFT_KEY, { signature: 'pending-signature', queueId: 'q-1' })
    persistComposerDraft(NEW_MISSION_DRAFT_KEY)
    migrateNewMissionComposerDrafts('c1')
    expect(composerSubmissionIds.get('c1')?.queueId).toBe('q-1')
    expect(composerSubmissionIds.has(NEW_MISSION_DRAFT_KEY)).toBe(false)
    expect(recoverComposerDraft(NEW_MISSION_DRAFT_KEY)).toBe(false)
    composerDrafts.set(NEW_MISSION_DRAFT_KEY, 'different')
    composerSubmissionIds.set(NEW_MISSION_DRAFT_KEY, { signature: 'different-signature', queueId: 'q-2' })
    migrateNewMissionComposerDrafts('c1')
    expect(composerSubmissionIds.get('c1')?.queueId).toBe('q-1')
  })
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
