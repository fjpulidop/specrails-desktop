import { beforeEach, describe, expect, it } from 'vitest'
import { composerDrafts, composerReferenceDrafts, writeComposerDraft } from '../agent-composer-drafts'
import { insertDroppedSpec, readSpecDrag } from '../agent-spec-drag'

const chip = { kind: 'spec' as const, id: '12', label: 'Build it', token: '@Build it', projectId: 'p1' }
const payload = JSON.stringify({ draftKey: 'm1', chip })

beforeEach(() => { composerDrafts.clear(); composerReferenceDrafts.clear() })

describe('mission spec drag', () => {
  it('accepts only valid spec references from the same mission and project', () => {
    expect(readSpecDrag(payload, 'm1', 'p1')).toMatchObject(chip)
    expect(readSpecDrag(payload, 'm2', 'p1')).toBeNull()
    expect(readSpecDrag(payload, 'm1', 'p2')).toBeNull()
    expect(readSpecDrag(payload, 'm1', null)).toBeNull()
    for (const raw of ['', 'null', '{', JSON.stringify({ draftKey: 'm1', chip: { ...chip, kind: 'job' } }),
      JSON.stringify({ draftKey: 'm1', chip: { ...chip, token: 'wrong' } })]) {
      expect(readSpecDrag(raw, 'm1', 'p1')).toBeNull()
    }
  })

  it('inserts at the caret without losing text or other references and ignores duplicates', () => {
    writeComposerDraft('m1', 'Ask @Other later', [{ key: 'other', start: 4, end: 10,
      chip: { ...chip, id: '3', label: 'Other', token: '@Other' } }])
    const caret = insertDroppedSpec('m1', chip, 4)
    expect(composerDrafts.get('m1')).toBe('Ask @Build it @Other later')
    expect(composerReferenceDrafts.get('m1')?.map(ref => [ref.chip.id, ref.start, ref.end])).toEqual([
      ['12', 4, 13], ['3', 14, 20],
    ])
    insertDroppedSpec('m1', chip, caret)
    expect(composerReferenceDrafts.get('m1')).toHaveLength(2)
  })

  it('places a drop after an atomic reference when the caret is inside it', () => {
    writeComposerDraft('m1', '@Other', [{ key: 'other', start: 0, end: 6,
      chip: { ...chip, id: '3', label: 'Other', token: '@Other' } }])
    insertDroppedSpec('m1', chip, 2)
    expect(composerDrafts.get('m1')).toBe('@Other @Build it ')
    expect(composerReferenceDrafts.get('m1')?.[0].end).toBe(6)
  })
})
