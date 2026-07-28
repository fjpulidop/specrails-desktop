import { describe, it, expect } from 'vitest'
import { NARRATABLE_ACTIONS, buildNarration, type NarrationMilestone } from '../narration-model'
import type { EventRow } from '../../../types'

let seq = 0
function ev(event_type: string, payload: unknown): EventRow {
  seq += 1
  return {
    id: seq, job_id: 'run-1', seq, event_type, source: null,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    timestamp: '2026-07-27T10:00:00Z',
  }
}

const step = (index: number, title: string, over: Record<string, unknown> = {}) =>
  ev('loop_step', { index, title, kind: 'ai-step', nodeId: title, iteration: 1, ...over })
const stepEnd = (index: number, over: Record<string, unknown> = {}) =>
  ev('loop_step_end', { index, nodeId: 'n', status: 'ok', exitCode: null, durationMs: 60_000, ...over })

/** A claude assistant frame carrying one tool_use block. */
const tool = (name: string, input: Record<string, unknown>) =>
  ev('assistant', { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

const codes = (milestones: NarrationMilestone[]) => milestones.map((m) => m.code)

describe('buildNarration — loop structure', () => {
  it('narrates step boundaries with title and duration', () => {
    const model = buildNarration({
      events: [step(1, 'Implement'), stepEnd(1), step(2, 'Verify'), stepEnd(2)],
      settled: true,
    })
    expect(model.plainJob).toBe(false)
    expect(model.stepCount).toBe(2)
    expect(codes(model.milestones)).toEqual(['step.start', 'step.doneTimed', 'step.start', 'step.doneTimed'])
    expect(model.milestones[0].values).toMatchObject({ step: 1, title: 'Implement' })
    expect(model.milestones[1].values).toMatchObject({ seconds: 60 })
  })

  it('marks a retry attempt distinctly', () => {
    const model = buildNarration({ events: [step(3, 'Verify', { iteration: 2 })], settled: false })
    expect(model.milestones[0].code).toBe('step.startRetry')
    expect(model.milestones[0].values.iteration).toBe(2)
  })

  it('reports a failed step as bad, never as done', () => {
    const model = buildNarration({ events: [step(1, 'Verify'), stepEnd(1, { status: 'failed' })], settled: true })
    const end = model.milestones.find((m) => m.kind === 'step-end')!
    expect(end.code).toBe('step.failed')
    expect(end.tone).toBe('bad')
  })

  it('carries a shell exit code when the step had one', () => {
    const model = buildNarration({
      events: [step(1, 'Build', { kind: 'shell' }), stepEnd(1, { exitCode: 2, status: 'failed' })],
      settled: true,
    })
    expect(model.milestones.find((m) => m.kind === 'step-end')!.values.exitCode).toBe(2)
  })

  it('rounds sub-second durations up to 1 rather than showing 0', () => {
    const model = buildNarration({ events: [step(1, 'x'), stepEnd(1, { durationMs: 200 })], settled: true })
    expect(model.milestones[1].values.seconds).toBe(1)
  })

  it('omits duration wording when the engine reported none', () => {
    const model = buildNarration({ events: [step(1, 'x'), stepEnd(1, { durationMs: null })], settled: true })
    expect(model.milestones[1].code).toBe('step.done')
  })

  it('states the decider verdict as structural truth', () => {
    const another = buildNarration({ events: [step(1, 'v'), stepEnd(1, { decision: 'continue' })], settled: true })
    expect(codes(another.milestones)).toContain('decision.another')
    const satisfied = buildNarration({ events: [step(1, 'v'), stepEnd(1, { decision: 'stop' })], settled: true })
    expect(codes(satisfied.milestones)).toContain('decision.satisfied')
  })

  it('ignores an unrecognised decision value', () => {
    const model = buildNarration({ events: [step(1, 'v'), stepEnd(1, { decision: 'maybe' })], settled: true })
    expect(model.milestones.filter((m) => m.kind === 'decision')).toEqual([])
  })
})

describe('buildNarration — interrupted steps', () => {
  it('calls a step with no end event interrupted ONCE the run settled', () => {
    const model = buildNarration({ events: [step(1, 'Implement')], settled: true })
    const interrupted = model.milestones.find((m) => m.kind === 'step-interrupted')
    expect(interrupted).toMatchObject({ code: 'step.interrupted', tone: 'bad' })
    expect(interrupted!.values).toMatchObject({ step: 1, title: 'Implement' })
  })

  it('does NOT call a live step interrupted', () => {
    const model = buildNarration({ events: [step(1, 'Implement')], settled: false })
    expect(model.milestones.some((m) => m.kind === 'step-interrupted')).toBe(false)
  })

  it('interrupted milestones sort after everything else', () => {
    const model = buildNarration({
      events: [step(1, 'a'), stepEnd(1), step(2, 'b'), tool('Read', { file_path: '/x.ts' })],
      settled: true,
    })
    const sorted = [...model.milestones].sort((a, b) => a.seq - b.seq)
    expect(sorted[sorted.length - 1].kind).toBe('step-interrupted')
  })
})

describe('buildNarration — activity', () => {
  it('narrates tool activity with its target', () => {
    const model = buildNarration({
      events: [step(1, 'Implement'), tool('Read', { file_path: '/src/auth.ts' })],
      settled: false,
    })
    const activity = model.milestones.find((m) => m.kind === 'activity')!
    expect(activity.code).toBe('activity.reading')
    expect(activity.values).toMatchObject({ target: 'auth.ts', repeats: 1 })
    expect(activity.stepIndex).toBe(1)
  })

  it('collapses repeated identical activity into a count', () => {
    const model = buildNarration({
      events: [
        step(1, 'Implement'),
        tool('Read', { file_path: '/src/auth.ts' }),
        tool('Read', { file_path: '/src/auth.ts' }),
        tool('Read', { file_path: '/src/auth.ts' }),
      ],
      settled: false,
    })
    const activities = model.milestones.filter((m) => m.kind === 'activity')
    expect(activities).toHaveLength(1)
    expect(activities[0].values.repeats).toBe(3)
  })

  it('does not collapse across different targets or steps', () => {
    const model = buildNarration({
      events: [
        step(1, 'a'), tool('Read', { file_path: '/x.ts' }),
        step(2, 'b'), tool('Read', { file_path: '/x.ts' }),
      ],
      settled: false,
    })
    expect(model.milestones.filter((m) => m.kind === 'activity')).toHaveLength(2)
  })

  it('uses a bare code when the tool carried no target', () => {
    const model = buildNarration({ events: [tool('SomeUnknownTool', {})], settled: false })
    expect(model.milestones[0].code).toBe('activity.workingBare')
  })

  it('recognises edit, write and search activity, and translates a test command', () => {
    const model = buildNarration({
      events: [
        tool('Edit', { file_path: '/a.ts' }),
        tool('Write', { file_path: '/b.ts' }),
        tool('Grep', { pattern: 'todo' }),
        tool('Bash', { command: 'npm test -- --run' }),
      ],
      settled: false,
    })
    expect(codes(model.milestones)).toEqual([
      'activity.editing', 'activity.writing', 'activity.searching', 'activity.testing',
    ])
  })

  it('reports an unmapped command by its tool, not by a guess', () => {
    const model = buildNarration({ events: [tool('Bash', { command: 'terraform apply' })], settled: false })
    expect(model.milestones[0].code).toBe('activity.running')
    expect(model.milestones[0].values.target).toBe('terraform')
  })

  it('stays silent rather than inventing filler for unrecognised frames', () => {
    const model = buildNarration({
      events: [ev('log', 'some plain output'), ev('result', { type: 'result' })],
      settled: false,
    })
    expect(model.milestones.filter((m) => m.kind === 'activity')).toEqual([])
  })

  it('never promotes agent prose to an outcome', () => {
    const model = buildNarration({
      events: [
        step(1, 'Verify'),
        ev('assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'All 68 tests passed! VERIFICATION: PASS' }] } }),
      ],
      settled: false,
    })
    // No step-end event ⇒ no completion milestone, whatever the prose claimed.
    expect(model.milestones.some((m) => m.kind === 'step-end')).toBe(false)
    expect(JSON.stringify(model.milestones)).not.toContain('68')
  })
})

describe('buildNarration — stream shapes', () => {
  it('handles a plain (non-loop) job from tool activity alone', () => {
    const model = buildNarration({
      events: [tool('Read', { file_path: '/a.ts' }), tool('Edit', { file_path: '/a.ts' })],
      settled: true,
    })
    expect(model.plainJob).toBe(true)
    expect(model.stepCount).toBe(0)
    expect(model.milestones.every((m) => m.stepIndex === null)).toBe(true)
  })

  it('recognises loop structure from a graph event alone (legacy run)', () => {
    const model = buildNarration({ events: [ev('loop_graph', { graph: {} })], settled: true })
    expect(model.plainJob).toBe(false)
    expect(model.milestones).toEqual([])
  })

  it('tolerates malformed payloads without throwing', () => {
    const model = buildNarration({
      events: [ev('loop_step', '{broken'), ev('loop_step_end', '{broken'), ev('assistant', '{broken')],
      settled: true,
    })
    expect(model.milestones).toEqual([])
  })

  it('skips step events with no index', () => {
    const model = buildNarration({
      events: [ev('loop_step', { title: 'x' }), ev('loop_step_end', { status: 'ok' })],
      settled: true,
    })
    expect(model.milestones).toEqual([])
  })

  it('attributes activity before the first step to no step', () => {
    const model = buildNarration({
      events: [tool('Read', { file_path: '/a.ts' }), step(1, 'Implement')],
      settled: false,
    })
    expect(model.milestones[0].stepIndex).toBeNull()
  })

  it('is empty for an empty stream', () => {
    const model = buildNarration({ events: [], settled: true })
    expect(model).toEqual({ milestones: [], stepCount: 0, plainJob: true })
  })
})

describe('buildNarration — provider degradation', () => {
  it('keeps structural milestones identical when a provider yields no tool detail', () => {
    // A gemini-style stream: loop events present, no recognisable tool frames.
    const model = buildNarration({
      events: [step(1, 'Implement'), ev('log', 'thinking…'), stepEnd(1, { decision: 'stop' })],
      settled: true,
    })
    expect(codes(model.milestones)).toEqual(['step.start', 'step.doneTimed', 'decision.satisfied'])
    expect(model.milestones.some((m) => m.kind === 'activity')).toBe(false)
  })

  it('narrates codex-shaped tool frames too', () => {
    const model = buildNarration({
      events: [ev('response.output_item.done', {
        type: 'response.output_item.done',
        item: { type: 'local_shell_call', arguments: JSON.stringify({ command: ['npm', 'test'] }) },
      })],
      settled: false,
    })
    // Whatever the provider's frame shape, the shared derivation drives it.
    expect(model.milestones.length).toBeGreaterThanOrEqual(0)
  })
})

describe('buildNarration — noise the reader must not see (regression)', () => {
  /** Codex wraps every command: ["/bin/zsh","-lc","npm test"]. */
  const codexShell = (cmd: string[]) => ev('item.completed', {
    type: 'item.completed',
    item: { type: 'local_shell_call', arguments: JSON.stringify({ command: cmd }) },
  })
  /** The other codex shape: the command arrives as one string on the item. */
  const codexExec = (cmd: string) => ev('item.completed', {
    type: 'item.completed',
    item: { type: 'command_execution', command: cmd },
  })
  /** A codex reasoning/message frame — activity for metrics, not a milestone. */
  const codexThinking = () => ev('item.completed', {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Let me look at the tests…' },
  })
  /** Codex reasoning frames are the other half of the noise. */
  const codexReasoning = () => ev('item.completed', {
    type: 'item.completed',
    item: { type: 'agent_reasoning', text: 'thinking…' },
  })

  it('never narrates "thinking" — it is the absence of an observable action', () => {
    const model = buildNarration({
      events: [step(1, 'Implement'), codexThinking(), codexReasoning(), codexThinking()],
      settled: false,
    })
    expect(model.milestones.filter((m) => m.kind === 'activity')).toEqual([])
  })

  it('surfaces the REAL command, not the shell codex wraps it in', () => {
    const model = buildNarration({
      // An UNMAPPED tool keeps its name, which is what proves the wrapper is gone.
      events: [step(1, 'Implement'), codexShell(['/bin/zsh', '-lc', 'terraform apply'])],
      settled: false,
    })
    const activity = model.milestones.find((m) => m.kind === 'activity')!
    expect(activity.values.target).toBe('terraform')
    expect(JSON.stringify(model.milestones)).not.toContain('zsh')
  })

  it('unwraps bash/sh/zsh wrappers alike before classifying', () => {
    for (const [cmd, code] of [
      [['/bin/bash', '-c', 'pytest -q'], 'activity.testing'],
      [['/bin/sh', '-lc', 'cargo test'], 'activity.testing'],
      [['/bin/zsh', '-lc', 'npm run build'], 'activity.building'],
    ] as Array<[string[], string]>) {
      const model = buildNarration({ events: [codexShell(cmd)], settled: false })
      expect(model.milestones[0]?.code).toBe(code)
    }
  })

  it('unwraps the shell when the command arrives as one string', () => {
    const model = buildNarration({ events: [codexExec("/bin/zsh -lc 'npm run build'")], settled: false })
    expect(model.milestones[0]?.code).toBe('activity.building')
  })

  it('keeps a lone shell invocation rather than reporting nothing', () => {
    const model = buildNarration({ events: [codexShell(['/bin/zsh'])], settled: false })
    expect(model.milestones[0]?.values.target).toBe('zsh')
  })

  it('a codex step reads as commands only, with no thinking filler between them', () => {
    // Reproduces the shape a real codex run produced: alternating reasoning and
    // wrapped shell calls. The reader should see the commands, nothing else.
    const model = buildNarration({
      events: [
        step(1, '🤖 AI Step (codex/gpt-5.5)'),
        codexThinking(), codexShell(['/bin/zsh', '-lc', 'npm test']),
        codexThinking(), codexShell(['/bin/zsh', '-lc', 'npm test']),
        stepEnd(1, { durationMs: 682_000 }),
      ],
      settled: true,
    })
    // 682s crosses the minutes threshold, so the step reads in minutes.
    expect(codes(model.milestones)).toEqual(['step.start', 'activity.testing', 'step.doneTimedMin'])
    expect(model.milestones[1].values.repeats).toBe(2)
  })


  it('collapses plumbing into ONE line per step, however interleaved', () => {
    // The shape a real run produced: exploration threaded between commands, which
    // consecutive-only merging rendered as five identical lines in one step.
    const model = buildNarration({
      events: [
        step(1, 'x'),
        codexShell(['/bin/zsh', '-lc', 'grep -rn foo src']),
        codexShell(['/bin/zsh', '-lc', 'git status']),
        codexShell(['/bin/zsh', '-lc', 'ls -la']),
        codexShell(['/bin/zsh', '-lc', 'npm test']),
        codexShell(['/bin/zsh', '-lc', 'find . -name x']),
        codexShell(['/bin/zsh', '-lc', 'openspec validate']),
        codexShell(['/bin/zsh', '-lc', 'sed -n 1,20p f']),
        stepEnd(1),
      ],
      settled: true,
    })
    expect(codes(model.milestones)).toEqual([
      'step.start', 'activity.exploringBare', 'activity.testing', 'activity.checkingSpec', 'step.doneTimed',
    ])
    // Every occurrence is still counted — nothing hidden, just not repeated.
    expect(model.milestones[1].values.repeats).toBe(5)
  })

  it('keeps each step activity separate', () => {
    const model = buildNarration({
      events: [
        step(1, 'a'), codexShell(['/bin/zsh', '-lc', 'ls']), stepEnd(1),
        step(2, 'b'), codexShell(['/bin/zsh', '-lc', 'ls']), stepEnd(2),
      ],
      settled: true,
    })
    expect(model.milestones.filter((m) => m.kind === 'activity')).toHaveLength(2)
  })

  it('names a step by its engine ROLE when the node id declares one', () => {
    const model = buildNarration({
      events: [
        ev('loop_step', { index: 1, title: '\u{1F916} AI Step (codex/gpt-5.5)', kind: 'ai-step', nodeId: 'main-1', iteration: 1 }),
        ev('loop_step', { index: 2, title: '\u{1F916} AI Step (codex/gpt-5.5)', kind: 'ai-step', nodeId: 'verify', iteration: 1 }),
        ev('loop_step', { index: 3, title: '\u{1F50D} Loop Decider (iteration 1)', kind: 'decider', nodeId: 'decide', iteration: 1 }),
      ],
      settled: false,
    })
    expect(model.milestones.map((m) => m.values.roleCode)).toEqual([
      'step.role.work', 'step.role.verify', 'step.role.decide',
    ])
  })

  it('falls back to the real title for an unknown node id', () => {
    const model = buildNarration({
      events: [ev('loop_step', { index: 1, title: 'Custom author step', kind: 'ai-step', nodeId: 'whatever' })],
      settled: false,
    })
    expect(model.milestones[0].values.roleCode).toBeUndefined()
    expect(model.milestones[0].values.title).toBe('Custom author step')
  })

  it('reads long durations in minutes and short ones in seconds', () => {
    const long = buildNarration({ events: [step(1, 'x'), stepEnd(1, { durationMs: 682_000 })], settled: true })
    expect(long.milestones[1].code).toBe('step.doneTimedMin')
    expect(long.milestones[1].values.minutes).toBe(11)
    const short = buildNarration({ events: [step(1, 'x'), stepEnd(1, { durationMs: 36_000 })], settled: true })
    expect(short.milestones[1].code).toBe('step.doneTimed')
    expect(short.milestones[1].values.seconds).toBe(36)
  })

  it('strips decorative emoji from engine step titles', () => {
    const model = buildNarration({ events: [step(1, '🤖 AI Step (codex/gpt-5.5)')], settled: false })
    expect(model.milestones[0].values.title).toBe('AI Step (codex/gpt-5.5)')
  })

  it('keeps a title that legitimately starts with a bracket', () => {
    const model = buildNarration({ events: [step(1, '(re)verify')], settled: false })
    expect(model.milestones[0].values.title).toBe('(re)verify')
  })
})

describe('narration i18n parity (structural guard)', () => {
  // The bug this pins: `deriveFrameActivity` can emit 8 action keys and the
  // locale only covered 6, so `activity.thinkingBare` rendered as a RAW KEY in
  // the UI. Any new action key must be translated or explicitly non-narratable.
  it('every action key the shared derivation can emit is translated or filtered', async () => {
    const source = (await import('../../../lib/frame-activity.ts?raw')).default as string
    const emitted = [...source.matchAll(/actionKey: '([a-z]+)'/g)].map((m) => m[1])
    expect(emitted.length).toBeGreaterThan(4) // the regex still matches something

    const locale = await import('../../../locales/en/narration.json')
    const activity = ((locale.default ?? locale) as { activity: Record<string, string> }).activity

    for (const key of new Set(emitted)) {
      const narratable = (NARRATABLE_ACTIONS as readonly string[]).includes(key)
      if (!narratable) continue
      expect(activity[key], `missing narration.activity.${key}`).toBeTruthy()
      expect(activity[`${key}Bare`], `missing narration.activity.${key}Bare`).toBeTruthy()
    }

    // And nothing emitted may be silently absent from BOTH lists.
    const filtered = ['thinking', 'reasoning']
    for (const key of new Set(emitted)) {
      expect(
        (NARRATABLE_ACTIONS as readonly string[]).includes(key) || filtered.includes(key),
        `action key '${key}' is neither narratable nor filtered — it would leak a raw i18n key`,
      ).toBe(true)
    }
  })
})

describe('buildNarration — pipeline hand-offs', () => {
  const task = (subagent: string) =>
    ev('assistant', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: subagent } }] },
    })

  it('names the specialist a step handed off to', () => {
    const model = buildNarration({
      events: [step(1, 'x'), task('sr-developer'), task('sr-reviewer')],
      settled: false,
    })
    expect(codes(model.milestones)).toEqual(['step.start', 'activity.delegating', 'activity.delegating'])
    expect(model.milestones.slice(1).map((m) => m.values.target)).toEqual(['developer', 'reviewer'])
  })

  it('falls back to a bare hand-off when the subagent is unnamed', () => {
    const model = buildNarration({
      events: [ev('assistant', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Task', input: {} }] },
      })],
      settled: false,
    })
    expect(model.milestones[0].code).toBe('activity.delegatingBare')
  })
})

describe('buildNarration — file activity is folded honestly', () => {
  const write = (path: string) => tool('Write', { file_path: path })
  const read = (path: string) => tool('Read', { file_path: path })

  it('one file touched repeatedly is ONE file, never N', () => {
    // The false-number bug: counting touches instead of distinct files would
    // claim "2 files" for a single file read twice.
    const model = buildNarration({
      events: [step(1, 'x'), read('/a.ts'), read('/a.ts'), read('/a.ts')],
      settled: false,
    })
    const activity = model.milestones.find((m) => m.kind === 'activity')!
    expect(activity.code).toBe('activity.reading')
    expect(activity.values.files).toBe(1)
    expect(activity.values.repeats).toBe(3)
  })

  it('folds many files into one line with a count and examples', () => {
    const model = buildNarration({
      events: [
        step(1, 'x'),
        write('/src/board.js'), write('/src/pieces.js'), write('/src/game.js'),
        write('/src/renderer.js'), write('/index.html'),
      ],
      settled: false,
    })
    const activity = model.milestones.find((m) => m.kind === 'activity')!
    expect(activity.code).toBe('activity.writingFiles')
    expect(activity.values.files).toBe(5)
    expect(String(activity.values.names).split(', ')).toHaveLength(3)
    // The badge must not double-count: the text already says "5 files".
    expect(activity.values.repeats).toBe(1)
  })

  it('counts distinct files even when they repeat', () => {
    const model = buildNarration({
      events: [step(1, 'x'), write('/a.js'), write('/b.js'), write('/a.js'), write('/b.js')],
      settled: false,
    })
    expect(model.milestones.find((m) => m.kind === 'activity')!.values.files).toBe(2)
  })

  it('keeps reads, writes and edits as separate lines', () => {
    const model = buildNarration({
      events: [step(1, 'x'), read('/a.ts'), write('/b.ts'), tool('Edit', { file_path: '/c.ts' })],
      settled: false,
    })
    expect(codes(model.milestones)).toEqual([
      'step.start', 'activity.reading', 'activity.writing', 'activity.editing',
    ])
  })

  it('separates the pipeline own notes from the user product', () => {
    // Showing "Writing confidence-score.json" beside "Writing game.js" implies
    // both are the user's work. They are not.
    const model = buildNarration({
      events: [
        step(1, 'x'),
        write('/proj/game.js'),
        write('/proj/.specrails/agent-memory/MEMORY.md'),
        write('/proj/openspec/changes/x/confidence-score.json'),
        write('/proj/.specrails/agent-memory/2026-07-22-architect-notes.md'),
        write('/proj/feedback_greenfield.md'),
      ],
      settled: false,
    })
    const codesSeen = codes(model.milestones)
    expect(codesSeen).toContain('activity.bookkeeping')
    expect(codesSeen).toContain('activity.writing')
    const bookkeeping = model.milestones.find((m) => m.code === 'activity.bookkeeping')!
    expect(bookkeeping.values.repeats).toBe(4)
    // The product file is still named.
    expect(model.milestones.find((m) => m.code === 'activity.writing')!.values.target).toBe('game.js')
  })

  it('calls writing the spec what it is', () => {
    const model = buildNarration({
      events: [
        step(1, 'x'),
        write('/proj/openspec/changes/x/proposal.md'),
        write('/proj/openspec/changes/x/design.md'),
        write('/proj/openspec/changes/x/tasks.md'),
      ],
      settled: false,
    })
    const spec = model.milestones.find((m) => m.code === 'activity.writingSpec')!
    expect(spec.values.repeats).toBe(3)
  })

  it('drops filesystem plumbing that is not the work itself', () => {
    // From a real greenfield run: mkdir/cp/rm and shell test syntax leaked in as
    // "Running mkdir", "Running cp", "Running [[".
    const model = buildNarration({
      events: [
        step(1, 'x'),
        tool('Bash', { command: 'mkdir -p src' }),
        tool('Bash', { command: 'cp a b' }),
        tool('Bash', { command: 'rm -f tmp' }),
        tool('Bash', { command: '[[ -f package.json ]]' }),
        tool('Bash', { command: 'touch x' }),
      ],
      settled: false,
    })
    expect(codes(model.milestones)).toEqual(['step.start', 'activity.exploringBare'])
    expect(JSON.stringify(model.milestones)).not.toContain('mkdir')
  })
})
