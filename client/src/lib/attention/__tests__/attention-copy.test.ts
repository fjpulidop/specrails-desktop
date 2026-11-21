import { afterEach, describe, expect, it } from 'vitest'
import i18n, { setLanguage } from '../../i18n'
import {
  actionKindOf, attentionActionLabel, attentionReturnCopy, attentionSummary, singleAttentionMessage, subjectLabel,
  type AttentionCopy, type AttentionCopyKind,
} from '../attention-copy'

const t = (key: string, options?: Record<string, unknown>): string => String(i18n.t(key, options))
const open = (): void => {}

afterEach(async () => { await setLanguage('en') })

describe('attention copy: one item', () => {
  const item = (kind: AttentionCopyKind): AttentionCopy => ({ kind, project: 'Generala Dorada', subject: '#6 Scoreboard' })

  it.each([
    ['question', 'Generala Dorada · #6 Scoreboard is waiting for your answer', 'Answer'],
    ['approval', 'Generala Dorada · #6 Scoreboard needs your approval', 'Review'],
    ['review', 'Generala Dorada · #6 Scoreboard is ready for review', 'Review'],
    ['stopped', 'Generala Dorada · #6 Scoreboard has stopped', 'View'],
    ['stuck', 'Generala Dorada · #6 Scoreboard: a run has stalled', 'View'],
    ['paused', 'Generala Dorada · #6 Scoreboard is paused by a limit', 'View'],
    ['done', 'Generala Dorada · #6 Scoreboard has finished', 'View'],
    ['generic', 'Generala Dorada · #6 Scoreboard needs your attention', 'View'],
  ] as const)('%s → its sentence and action (EN)', (kind, message, action) => {
    expect(attentionReturnCopy([{ copy: item(kind), open }], t, 'en')).toEqual({ message, action, open })
  })

  it('speaks Spanish with the same mapping', async () => {
    await setLanguage('es')
    expect(attentionReturnCopy([{ copy: item('question'), open }], t, 'es')).toMatchObject({ message: 'Generala Dorada · #6 Scoreboard espera tu respuesta', action: 'Responder' })
    expect(attentionReturnCopy([{ copy: item('approval'), open }], t, 'es')).toMatchObject({ message: 'Generala Dorada · #6 Scoreboard necesita tu aprobación', action: 'Revisar' })
    expect(attentionReturnCopy([{ copy: { kind: 'review', project: 'Tetrisex', subject: '#12' }, open }], t, 'es')).toMatchObject({ message: 'Tetrisex · #12 está listo para revisar', action: 'Revisar' })
    expect(attentionReturnCopy([{ copy: item('stopped'), open }], t, 'es')).toMatchObject({ message: 'Generala Dorada · #6 Scoreboard se ha detenido', action: 'Ver' })
    expect(attentionReturnCopy([{ copy: item('generic'), open }], t, 'es')).toMatchObject({ message: 'Generala Dorada · #6 Scoreboard requiere tu atención', action: 'Ver' })
  })

  it('a mission reply keeps its own sentence and opens the mission', () => {
    const copy: AttentionCopy = { kind: 'reply', project: 'Alpha', message: 'Login flow replied' }
    expect(attentionReturnCopy([{ copy, open }], t, 'en')).toEqual({ message: 'Login flow replied', action: 'Open', open })
  })

  it('falls back to the event title, then to a plain count, when the item names nothing', () => {
    expect(singleAttentionMessage({ kind: 'stuck' }, t, 'Run seems stuck')).toBe('Run seems stuck')
    expect(singleAttentionMessage(undefined, t)).toBe('1 pending item')
    expect(attentionReturnCopy([{ open }], t, 'en')).toEqual({ message: '1 pending item', action: 'Open', open })
  })

  it('an item without a place of its own offers the inbox', () => {
    expect(attentionReturnCopy([{ copy: item('question') }], t, 'en')).toEqual({ message: 'Generala Dorada · #6 Scoreboard is waiting for your answer', action: 'Open inbox' })
  })

  it('subject: project first, a long title clipped, a repeated project not doubled', () => {
    expect(subjectLabel({ project: 'Alpha', subject: 'Alpha' })).toBe('Alpha')
    expect(subjectLabel({ project: null, subject: '  Add   login ' })).toBe('Add login')
    const long = subjectLabel({ project: 'Alpha', subject: 'x'.repeat(200) })
    expect(long.length).toBeLessThan(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('action kinds', () => {
    expect(actionKindOf('question')).toBe('answer')
    expect(actionKindOf('approval')).toBe('review')
    expect(actionKindOf('review')).toBe('review')
    expect(actionKindOf('stopped')).toBe('view')
    expect(actionKindOf('reply')).toBe('open')
    expect(actionKindOf(undefined)).toBe('open')
    expect(attentionActionLabel({ kind: 'question' }, t)).toBe('Answer')
  })
})

describe('attention copy: several items', () => {
  it('a plain count when kinds are mixed or unknown; the action opens the inbox', () => {
    const copy = attentionReturnCopy([{ copy: { kind: 'question' }, open }, { copy: { kind: 'stopped' } }, {}], t, 'en')
    expect(copy).toEqual({ message: '3 pending items', action: 'Open inbox' })
  })

  it('by kind when every item is a question, an approval or a review', () => {
    expect(attentionSummary([{ kind: 'question' }, { kind: 'question' }, { kind: 'review' }], t, 'en')).toBe('2 questions and 1 review pending')
    expect(attentionSummary([{ kind: 'review' }, { kind: 'review' }], t, 'en')).toBe('2 reviews pending')
    expect(attentionSummary([{ kind: 'question' }, { kind: 'approval' }, { kind: 'review' }], t, 'en')).toBe('1 question, 1 approval, and 1 review pending')
  })

  it('Spanish plurals', async () => {
    await setLanguage('es')
    expect(attentionSummary([{ kind: 'question' }, { kind: 'stopped' }, { kind: 'review' }], t, 'es')).toBe('3 avisos pendientes')
    expect(attentionSummary([{ kind: 'question' }, { kind: 'question' }, { kind: 'review' }], t, 'es')).toBe('2 preguntas y 1 revisión pendientes')
    expect(attentionReturnCopy([{}, {}], t, 'es')).toEqual({ message: '2 avisos pendientes', action: 'Ver bandeja' })
  })

  it('languages without plural forms read naturally', async () => {
    await setLanguage('ja')
    expect(attentionSummary([{}, {}, {}], t, 'ja')).toBe('未対応の項目が 3 件あります')
    expect(attentionSummary([{ kind: 'question' }, { kind: 'question' }, { kind: 'review' }], t, 'ja')).toBe('未対応：質問 2 件、レビュー 1 件')
    await setLanguage('zh')
    expect(attentionSummary([{}, {}], t, 'zh')).toBe('2 项待处理')
  })
})
