import { describe, expect, it } from 'vitest'
import { analysisLanguage, evidenceHash, failureAnalysisPrompt, failureEvidence, logLinesFromEvents, parseFailureAnalysis } from '../analysis'

const log = (line: string) => ({ event_type: 'log', payload: JSON.stringify({ line }) })
const job = { command: 'loop:implement', status: 'failed', provider: 'codex', model: 'gpt-6.1-sol' }

describe('failure analysis', () => {
  it('reads log lines and the runtime step markers, skipping noise', () => {
    const lines = logLinesFromEvents([
      log('first\nsecond'),
      { event_type: 'loop_step_end', payload: JSON.stringify({ status: 'failed', exitCode: 1 }) },
      { event_type: 'telemetry', payload: JSON.stringify({ tokens: 3 }) },
      { event_type: 'log', payload: 'not json' },
    ])
    expect(lines).toEqual(['first', 'second', '[loop_step_end] status=failed exitCode=1'])
  })

  it('keeps the newest lines within its budget and says when it cut', () => {
    const events = Array.from({ length: 600 }, (_, index) => log(`line ${index}`))
    const evidence = failureEvidence({ job, diagnosis: null, events })
    expect(evidence.lines).toHaveLength(400)
    expect(evidence.lines.at(-1)).toBe('line 599')
    expect(evidence.truncated).toBe(true)
  })

  it('hashes the evidence with the language and asks for an answer in it', () => {
    const evidence = failureEvidence({ job, diagnosis: { kind: 'unknown', detail: null }, events: [log('x')] })
    expect(evidenceHash(evidence, 'es')).not.toBe(evidenceHash(evidence, 'en'))
    expect(failureAnalysisPrompt(analysisLanguage('es-ES'))).toContain('in Spanish')
    expect(analysisLanguage('xx')).toBe('en')
  })

  it('keeps only evidence quoted verbatim from the log and bounds the answer', () => {
    const evidence = failureEvidence({ job, diagnosis: null, events: [log('[runtime] step_failed: developer — OpenSpec change metadata is missing')] })
    const analysis = parseFailureAnalysis(`Sure:\n${JSON.stringify({
      headline: 'Developer failed', cause: 'The change metadata is missing.', category: 'missing_artifact', failedStep: 'developer',
      evidence: ['[runtime] step_failed: developer — OpenSpec change metadata is missing', 'an invented line that was never logged'],
      nextSteps: ['Run the architect', '', 'Retry', 'A fourth step'],
    })}`, evidence)
    expect(analysis.evidence).toEqual(['[runtime] step_failed: developer — OpenSpec change metadata is missing'])
    expect(analysis.nextSteps).toEqual(['Run the architect', 'Retry', 'A fourth step'])
    expect(analysis.category).toBe('missing_artifact')
  })

  it('maps an unknown category to other and rejects an answer without a cause', () => {
    const evidence = failureEvidence({ job, diagnosis: null, events: [log('x')] })
    expect(parseFailureAnalysis(JSON.stringify({ headline: 'h', cause: 'c', category: 'cosmic-rays', failedStep: 'null' }), evidence))
      .toMatchObject({ category: 'other', failedStep: null, evidence: [], nextSteps: [] })
    expect(() => parseFailureAnalysis('no json here', evidence)).toThrow(/no JSON/)
    expect(() => parseFailureAnalysis(JSON.stringify({ headline: 'h' }), evidence)).toThrow(/missing headline or cause/)
  })
})
