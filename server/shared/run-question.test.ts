import { describe, expect, it } from 'vitest'
import { questionAsker, runQuestionFrom, runQuestionFromStatus, shortQuestion } from './run-question'

const structured = {
  id: 'i-1', nodePath: 'developer', kind: 'question',
  value: { kind: 'question', prompt: 'Task 2.1 needs touch.\n\nOptions:\n- Implement\n- Drop', text: 'Task 2.1 needs touch.', asker: 'build', recommended: 'drop',
    options: [{ id: 'implement', label: 'Implement touch', meaning: 'Adds it.' }, { id: 'drop', label: 'Drop 2.1', meaning: 'Keeps the non-goal.' }, { id: 'Bad Id', label: 'x' }], endsRun: ['ghost'] },
}

describe('the run question card', () => {
  it('reads a structured question from Core (questionOptions): who asks in plain words, the bare question, valid choices only', () => {
    expect(runQuestionFrom([structured])).toEqual({
      interruptId: 'i-1', kind: 'question', asker: 'developer', text: 'Task 2.1 needs touch.',
      options: [{ id: 'implement', label: 'Implement touch', meaning: 'Adds it.' }, { id: 'drop', label: 'Drop 2.1', meaning: 'Keeps the non-goal.' }],
      recommended: 'drop', endsRun: [], mayEndRun: false, canReject: false,
    })
  })

  it('renders an older Core\'s plain question as text, without node ids or paths', () => {
    const card = runQuestionFrom([{ id: 'i-2', nodePath: 'clarify', kind: 'question', value: { kind: 'question', prompt: 'clarify: Which store?' } }])
    expect(card).toMatchObject({ kind: 'question', asker: 'planner', text: 'Which store?', options: [], mayEndRun: true })
    expect(JSON.stringify(card)).not.toContain('clarify')
  })

  it('an approval offers Reject only when Core says it can be rejected', () => {
    const approval = { id: 'i-3', nodePath: 'approve', kind: 'approval', value: { kind: 'approval', prompt: 'Approve archiving?' } }
    expect(runQuestionFrom([approval])).toMatchObject({ kind: 'approval', text: 'Approve archiving?', canReject: false, mayEndRun: false })
    expect(runQuestionFrom([{ ...approval, value: { ...approval.value, rejectable: true } }])).toMatchObject({ canReject: true, mayEndRun: true })
  })

  it('ignores host tasks and reads the retained status of a run paused across a restart', () => {
    expect(runQuestionFrom([{ id: 'h', nodePath: 'x', kind: 'host-task', value: {} }])).toBeNull()
    expect(runQuestionFromStatus(JSON.stringify({ pendingInterrupts: [structured] }))?.interruptId).toBe('i-1')
    expect(runQuestionFromStatus('not json')).toBeNull()
    expect(runQuestionFromStatus(JSON.stringify({ pendingInterrupts: [] }))).toBeNull()
  })

  it('carries the machine-wide install question exactly as Core asks it (machineInstalls: options + data)', () => {
    const card = runQuestionFrom([{ id: 'i-4', nodePath: 'developer', kind: 'question', value: { kind: 'question', prompt: 'This run needs terraform. Install it with `brew install terraform`?',
      options: [{ id: 'install', label: 'Install', meaning: 'Specrails runs this exact command once.' }, { id: 'self', label: "I'll do it myself", meaning: 'Nothing is installed.' }],
      data: { kind: 'machine-install', command: 'brew install terraform', tool: 'terraform' } } }])
    expect(card).toMatchObject({ kind: 'question', asker: 'install', install: { tool: 'terraform', command: 'brew install terraform' }, detail: 'brew install terraform',
      options: [{ id: 'install' }, { id: 'self' }], endsRun: ['self'], mayEndRun: true })
  })

  it('names who asks and shortens the question for a notification', () => {
    expect(questionAsker(undefined, 'unblock')).toBe('developer')
    expect(questionAsker('fixer', 'developer')).toBe('fixer')
    expect(questionAsker(undefined, 'something')).toBe('run')
    expect(shortQuestion({ text: 'a'.repeat(200) }, 20)).toHaveLength(20)
    expect(shortQuestion({ text: '  Which\n store? ' })).toBe('Which store?')
  })
  it('asks the reason when the question text is empty (bench5 codex planner), never an empty card', () => {
    const why = 'The export checkout is not in this run; include it or stop here?'
    const q = runQuestionFrom([{ id: 'i1', kind: 'question', nodePath: 'clarify', value: { kind: 'question', asker: 'architect', text: '', prompt: '\n\n' + why, why, options: [] } }])
    expect(q).toMatchObject({ text: why, asker: 'planner' })
    expect(q).not.toHaveProperty('why')
  })
})
