import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDesktopDb } from './desktop-db'
import { createAgentConversation, addAgentMessage, listAgentMessages } from './agent-store'
import type { DbInstance } from './db'
import {
  hasValidProblemFrame,
  evaluateFramingState,
  checkSpecFraming,
  recordSpecCommitted,
  framingRefusalMessage,
  FRAMING_WAIVER_TOKEN,
  FRAMING_RESTORE_TOKEN,
  SPEC_FRAMING_MARKER_KIND,
} from './agent-spec-framing'

const frame = {
  restated: { reading: 'Group the Settings sections', touches: ['client/src/pages/SettingsPage.tsx'] },
  alternative: { reading: 'Make one setting findable from anywhere', touches: ['client/src/components/CommandPalette.tsx'] },
  discriminator: 'Are you scanning the page, or did you arrive by accident?',
  assumptions: ['App-level settings, not per-project'],
  unknowns: [],
}
const fenced = (payload: unknown) => '```problem-frame\n' + JSON.stringify(payload) + '\n```'
const A = (content: string) => ({ role: 'assistant', content })
const U = (content: string) => ({ role: 'user', content })
const MARKER = { role: 'system', content: JSON.stringify({ kind: SPEC_FRAMING_MARKER_KIND }) }

describe('hasValidProblemFrame — mirrors the client parser', () => {
  it('accepts a well-formed block', () => {
    expect(hasValidProblemFrame(`prose\n\n${fenced(frame)}`)).toBe(true)
  })

  it('rejects content with no fence at all', () => {
    expect(hasValidProblemFrame('I understood you perfectly, drafting now.')).toBe(false)
  })

  it('rejects malformed JSON and missing required keys', () => {
    expect(hasValidProblemFrame('```problem-frame\nnot json\n```')).toBe(false)
    const { discriminator: _d, ...noQuestion } = frame
    expect(hasValidProblemFrame(fenced(noQuestion))).toBe(false)
    const { alternative: _a, ...noAlternative } = frame
    expect(hasValidProblemFrame(fenced(noAlternative))).toBe(false)
  })

  it('rejects an empty reading or an empty discriminator', () => {
    expect(hasValidProblemFrame(fenced({ ...frame, discriminator: '  ' }))).toBe(false)
    expect(hasValidProblemFrame(fenced({ ...frame, alternative: { reading: ' ', touches: [] } }))).toBe(false)
  })

  it('rejects two readings that are literally the same reading', () => {
    const same = { ...frame, alternative: { ...frame.alternative, reading: frame.restated.reading } }
    expect(hasValidProblemFrame(fenced(same))).toBe(false)
  })

  it('accepts readings that share surfaces but differ in wording', () => {
    const shared = { ...frame, alternative: { reading: 'Only the empty state changes', touches: [...frame.restated.touches] } }
    expect(hasValidProblemFrame(fenced(shared))).toBe(true)
  })

  it('accepts a lenient unclosed fence whose JSON tail is whole', () => {
    expect(hasValidProblemFrame('done\n\n```problem-frame\n' + JSON.stringify(frame))).toBe(true)
  })

  it('rejects a truncated streaming tail', () => {
    expect(hasValidProblemFrame('```problem-frame\n{ "restated": { "read')).toBe(false)
  })

  it('accepts when a later valid block follows an invalid one', () => {
    expect(hasValidProblemFrame(`${fenced({ restated: {} })}\n\n${fenced(frame)}`)).toBe(true)
  })
})

describe('evaluateFramingState — derived from the message list alone', () => {
  it('refuses an empty conversation with no_frame', () => {
    expect(evaluateFramingState([])).toEqual({ satisfied: false, waived: false, reason: 'no_frame' })
  })

  it('refuses when the agent talked but never framed', () => {
    const s = evaluateFramingState([U('add a spec for dark mode'), A('Sure, drafting it now.')])
    expect(s.reason).toBe('no_frame')
  })

  it('refuses a frame the user has not answered yet', () => {
    const s = evaluateFramingState([U('settings are confusing'), A(fenced(frame))])
    expect(s).toEqual({ satisfied: false, waived: false, reason: 'frame_unanswered' })
  })

  it('is satisfied once a user message follows the frame', () => {
    const s = evaluateFramingState([U('settings are confusing'), A(fenced(frame)), U('yes, the first one')])
    expect(s.satisfied).toBe(true)
    expect(s.waived).toBe(false)
  })

  it('treats a DISAGREEING answer as an answer (the gate never judges agreement)', () => {
    const s = evaluateFramingState([A(fenced(frame)), U('no, neither — I meant the sidebar')])
    expect(s.satisfied).toBe(true)
  })

  it('an invalid frame block does not count as a frame', () => {
    const s = evaluateFramingState([A(fenced({ restated: {} })), U('ok')])
    expect(s.reason).toBe('no_frame')
  })

  it('spends the frame on a commit: the next spec needs its own', () => {
    const base = [A(fenced(frame)), U('yes')]
    expect(evaluateFramingState(base).satisfied).toBe(true)
    const afterCommit = [...base, MARKER]
    expect(evaluateFramingState(afterCommit)).toEqual({
      satisfied: false, waived: false, reason: 'frame_consumed',
    })
  })

  it('a fresh frame after a commit re-arms the gate', () => {
    const s = evaluateFramingState([A(fenced(frame)), U('yes'), MARKER, A(fenced(frame)), U('yes again')])
    expect(s.satisfied).toBe(true)
  })

  it('an unrelated system row does not spend the frame', () => {
    const s = evaluateFramingState([
      A(fenced(frame)), U('yes'), { role: 'system', content: JSON.stringify({ kind: 'pr-decision' }) },
    ])
    expect(s.satisfied).toBe(true)
  })
})

describe('the waiver is a user command word, not a sentiment', () => {
  it('a user waiver satisfies the gate with no frame at all', () => {
    const s = evaluateFramingState([U(`just do it, ${FRAMING_WAIVER_TOKEN}`)])
    expect(s).toEqual({ satisfied: true, waived: true, reason: null })
  })

  it('the waiver is sticky across several specs', () => {
    const s = evaluateFramingState([U(FRAMING_WAIVER_TOKEN), MARKER, U('another one'), MARKER, U('and another')])
    expect(s.satisfied).toBe(true)
    expect(s.waived).toBe(true)
  })

  it('the restore token re-arms the gate', () => {
    const s = evaluateFramingState([U(FRAMING_WAIVER_TOKEN), U(`ok ${FRAMING_RESTORE_TOKEN} please`)])
    expect(s.satisfied).toBe(false)
    expect(s.waived).toBe(false)
  })

  it('#noframe is not read as the #frame restore token', () => {
    expect(evaluateFramingState([U(FRAMING_WAIVER_TOKEN)]).waived).toBe(true)
  })

  it('restore wins when one message somehow carries both', () => {
    const s = evaluateFramingState([U(`${FRAMING_WAIVER_TOKEN} no wait ${FRAMING_RESTORE_TOKEN}`)])
    expect(s.waived).toBe(false)
  })

  it('the token must stand alone — prose about it does not waive', () => {
    expect(evaluateFramingState([U('what does #noframexyz do?')]).waived).toBe(false)
    expect(evaluateFramingState([U('the word noframe means nothing here')]).waived).toBe(false)
  })

  it('an ASSISTANT message cannot waive on the user\'s behalf', () => {
    const s = evaluateFramingState([A(`I will skip framing: ${FRAMING_WAIVER_TOKEN}`), U('go ahead')])
    expect(s.waived).toBe(false)
    expect(s.satisfied).toBe(false)
  })
})

describe('refusal messages name the artifact and the action', () => {
  it('every reason states what is missing and how to fix it', () => {
    for (const reason of ['no_frame', 'frame_unanswered', 'frame_consumed'] as const) {
      const msg = framingRefusalMessage(reason)
      expect(msg).toContain('problem-frame')
      expect(msg).toContain('discriminator')
      expect(msg).toContain('#noframe')
    }
    expect(framingRefusalMessage('frame_unanswered')).toContain('has not answered')
    expect(framingRefusalMessage('frame_consumed')).toContain('each spec needs its own')
  })
})

describe('checkSpecFraming + recordSpecCommitted over a real conversation', () => {
  let db: DbInstance
  let conversationId: string

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    conversationId = createAgentConversation(db, {}).id
  })
  afterEach(() => db.close())

  it('refuses a conversation with no frame', () => {
    const refusal = checkSpecFraming(db, conversationId)
    expect(refusal).toContain('No frame has been shown')
  })

  it('allows the commit once the frame is answered, then spends it', () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'yes, the first reading' })
    expect(checkSpecFraming(db, conversationId)).toBeNull()

    recordSpecCommitted(db, conversationId)
    expect(checkSpecFraming(db, conversationId)).toContain('already spent')
  })

  it('the consumption marker is a system row, not a visible bubble', () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'yes' })
    recordSpecCommitted(db, conversationId)

    const rows = listAgentMessages(db, conversationId)
    const marker = rows[rows.length - 1]
    expect(marker.role).toBe('system')
    expect(JSON.parse(marker.content).kind).toBe(SPEC_FRAMING_MARKER_KIND)
  })

  it('a waived conversation never refuses', () => {
    addAgentMessage(db, { conversationId, role: 'user', content: FRAMING_WAIVER_TOKEN })
    expect(checkSpecFraming(db, conversationId)).toBeNull()
    recordSpecCommitted(db, conversationId)
    expect(checkSpecFraming(db, conversationId)).toBeNull()
  })
})

// ─── The retention bar (design.md Decision 8) ─────────────────────────────────
// The change records how it will be judged: after 50 answered frames, how many
// were SUPERSEDED by a corrected frame before their spec landed. A frame the
// user corrects is direct evidence the step caught a misframing that would
// otherwise have become a spec, been assigned to a rail, and been implemented.
//
// This test exists to prove the two counts are derivable from rows that already
// exist — deliberately WITHOUT shipping a counter, an event, or a dashboard for
// them. The derivation below uses only exported primitives, so the evaluation
// is a query run once by a person, not a product surface to maintain.

describe('retention criterion is derivable without instrumentation', () => {
  let db: DbInstance
  let conversationId: string

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    conversationId = createAgentConversation(db, {}).id
  })
  afterEach(() => db.close())

  /** Answered frames, and those replaced by a later frame before the commit. */
  function countFrameOutcomes(messages: readonly { role: string; content: string }[]) {
    let answered = 0
    let superseded = 0
    let openFrame: 'none' | 'pending' | 'answered' = 'none'
    for (const m of messages) {
      if (m.role === 'assistant' && hasValidProblemFrame(m.content)) {
        if (openFrame === 'answered') superseded += 1 // the answered one was corrected
        openFrame = 'pending'
        continue
      }
      if (m.role === 'user' && openFrame === 'pending') {
        answered += 1
        openFrame = 'answered'
        continue
      }
      if (m.role === 'system' && m.content.includes(SPEC_FRAMING_MARKER_KIND)) openFrame = 'none'
    }
    return { answered, superseded }
  }

  it('counts a frame the user accepted as answered and not superseded', () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'yes' })
    recordSpecCommitted(db, conversationId)
    expect(countFrameOutcomes(listAgentMessages(db, conversationId))).toEqual({ answered: 1, superseded: 0 })
  })

  it('counts a frame the user corrected as superseded — the signal the bar measures', () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'no — I meant the sidebar' })
    const corrected = { ...frame, restated: { reading: 'Fix the sidebar entry', touches: ['client/src/components/ArcSidebar.tsx'] } }
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(corrected) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'that is it' })
    recordSpecCommitted(db, conversationId)
    expect(countFrameOutcomes(listAgentMessages(db, conversationId))).toEqual({ answered: 2, superseded: 1 })
  })

  it('does not count an unanswered frame', () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    expect(countFrameOutcomes(listAgentMessages(db, conversationId))).toEqual({ answered: 0, superseded: 0 })
  })

  it('a commit closes the episode, so the next frame is not read as a correction', () => {
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'yes' })
    recordSpecCommitted(db, conversationId)
    addAgentMessage(db, { conversationId, role: 'assistant', content: fenced(frame) })
    addAgentMessage(db, { conversationId, role: 'user', content: 'yes again' })
    recordSpecCommitted(db, conversationId)
    expect(countFrameOutcomes(listAgentMessages(db, conversationId))).toEqual({ answered: 2, superseded: 0 })
  })
})
