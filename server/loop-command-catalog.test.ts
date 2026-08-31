import { describe, it, expect } from 'vitest'
import {
  LOOP_COMMANDS,
  getLoopCommand,
  expandCommands,
  dominantTicketScope,
  referencesClaudeOnlyCommand,
} from './loop-command-catalog'
import { interpolateSpec } from './loop-graph'

describe('loop command catalog', () => {
  it('ships implement (all), batch (all), freestyle (per-ticket, capability-gated)', () => {
    expect(getLoopCommand('implement')).toMatchObject({ coreCommand: 'implement', ticketScope: 'all' })
    expect(getLoopCommand('batch')).toMatchObject({ coreCommand: 'batch-implement', ticketScope: 'all' })
    expect(getLoopCommand('freestyle')).toMatchObject({ native: true, requiredCapability: 'freestyle', ticketScope: 'per-ticket' })
    expect(LOOP_COMMANDS.some((c) => c.name === 'verify')).toBe(true)
  })

  it('implement/batch embed ALL ticket ids (all scope)', () => {
    expect(expandCommands('{{cmd:implement}}', { provider: 'claude', ticketIds: [1, 2, 3] })).toBe('/specrails:implement #1 #2 #3 --yes')
    expect(expandCommands('{{cmd:batch}}', { provider: 'claude', ticketIds: [1, 2] })).toBe('/specrails:batch-implement #1 #2 --yes')
  })

  it('codex uses the $skill form', () => {
    expect(expandCommands('{{cmd:batch}}', { provider: 'codex', ticketIds: [4] })).toBe('$batch-implement #4 --yes')
  })

  it('falls back to a single specId and omits tickets when none', () => {
    expect(expandCommands('{{cmd:implement}}', { provider: 'claude', specId: 7 })).toBe('/specrails:implement #7 --yes')
    expect(expandCommands('{{cmd:implement}}', { provider: 'claude' })).toBe('/specrails:implement --yes')
  })

  it('freestyle expands to a raw autonomous prompt, NOT a slash command', () => {
    const out = expandCommands('{{cmd:freestyle}}', { provider: 'claude', ticketIds: [5] })
    expect(out).toContain('autonomously')
    expect(out).toContain('{{spec.title}}') // spec tokens survive for the data pass
    expect(out).not.toContain('/specrails:')
    expect(out).not.toContain('#5')
  })

  it('collapses unknown commands to empty', () => {
    expect(expandCommands('x {{cmd:bogus}} y', { provider: 'claude' })).toBe('x  y')
  })

  it('resolve-merge expands to a conflict-resolution prompt carrying the MERGE_SAFE token without a capability gate', () => {
    expect(getLoopCommand('resolve-merge')).toMatchObject({ ticketScope: 'per-ticket' })
    expect(getLoopCommand('resolve-merge')?.requiredCapability).toBeUndefined()
    const out = expandCommands('{{cmd:resolve-merge}}', { provider: 'codex', ticketIds: [1] })
    expect(out).toMatch(/conflict/i)
    // command expansion leaves the constant token for the constants pass to resolve
    expect(out).toContain('{{const:MERGE_SAFE}}')
  })

  it('dominantTicketScope reads the command scope', () => {
    expect(dominantTicketScope('{{cmd:implement}}')).toBe('all')
    expect(dominantTicketScope('{{cmd:batch}}')).toBe('all')
    expect(dominantTicketScope('{{cmd:freestyle}}')).toBe('per-ticket')
    expect(dominantTicketScope('plain prompt, no command')).toBe('per-ticket')
  })

  it('legacy referencesClaudeOnlyCommand helper flags the freestyle capability', () => {
    expect(referencesClaudeOnlyCommand('{{cmd:freestyle}}')).toBe(true)
    expect(referencesClaudeOnlyCommand('{{cmd:implement}}')).toBe(false)
  })

  it('{{cmd:loop}} resolves to the provider-native loop entry point, with a portable fallback', () => {
    expect(expandCommands('{{cmd:loop}}', { provider: 'claude' })).toBe('/loop')
    expect(expandCommands('{{cmd:loop}}', { provider: 'codex' })).toBe('$goal')
    // a provider without a native entry point falls back to the autonomous preamble (never empty)
    const gem = expandCommands('{{cmd:loop}}', { provider: 'gemini' })
    expect(gem.length).toBeGreaterThan(0)
    expect(gem).not.toBe('/loop')
    expect(gem.toLowerCase()).toContain('autonomously')
  })

  it('{{cmd:loop}} has no provider capability gate (portable across providers)', () => {
    expect(getLoopCommand('loop')?.requiredCapability).toBeUndefined()
    expect(referencesClaudeOnlyCommand('{{cmd:loop}}')).toBe(false)
  })

  it('providerNative precedence does not change commands that lack it', () => {
    // verify is a plain template command — identical for every provider, no providerNative branch
    const a = expandCommands('{{cmd:verify}}', { provider: 'claude' })
    const b = expandCommands('{{cmd:verify}}', { provider: 'gemini' })
    expect(a).toBe(b)
    expect(a).toContain('VERIFICATION: PASS')
  })

  it('ships the distilled common commands; gate commands are tooling-agnostic and carry the guardrails', () => {
    for (const name of ['test', 'lint', 'typecheck', 'build', 'coverage', 'format', 'commit', 'push', 'pr', 'ci-status', 'audit', 'docs-sync', 'review']) {
      const out = expandCommands(`{{cmd:${name}}}`, { provider: 'claude' })
      expect(out.length, name).toBeGreaterThan(0)
    }
    // gate/fix commands instruct detection (no hardcoded single stack) and inject GUARDRAILS
    for (const name of ['test', 'lint', 'typecheck', 'build', 'coverage', 'format', 'audit', 'docs-sync', 'review']) {
      const out = expandCommands(`{{cmd:${name}}}`, { provider: 'claude' })
      expect(out, name).toContain('{{const:GUARDRAILS}}')
    }
    expect(expandCommands('{{cmd:test}}', { provider: 'claude' }).toLowerCase()).toContain('detect')
    // pr runs once over ALL the rail's tickets
    expect(getLoopCommand('pr')?.ticketScope).toBe('all')
    expect(dominantTicketScope('{{cmd:pr}}')).toBe('all')
  })

  it('command-then-spec resolves end-to-end with all ticket ids', () => {
    const out = interpolateSpec(
      expandCommands('{{cmd:implement}}', { provider: 'claude', ticketIds: [1, 2] }),
      { ticketIds: [1, 2], title: 'X' }
    )
    expect(out).toBe('/specrails:implement #1 #2 --yes')
    expect(out).not.toContain('{{')
  })
  it('the fix step no longer falsely claims "reported failures" and offers a BLOCKED escape', () => {
    const fix = LOOP_COMMANDS.find((c) => c.name === 'fix')!
    const t = fix.template
    // It must NOT open by asserting a failure (the Decider routes here on ANY
    // not-done verdict, including a PASSED verification with the feature unbuilt).
    expect(t.startsWith('The verification step above reported failures')).toBe(false)
    // It branches on the REAL verdict and permits implementing missing work…
    expect(t).toContain('VERIFICATION: PASS')
    expect(t).toContain('VERIFICATION: FAIL')
    expect(t.toLowerCase()).toContain('implement the missing pieces')
    // …and gives a first-class blocked signal so a human-decision blocker halts.
    expect(t).toContain('LOOP_BLOCKED:')
  })
})


describe('revision commands — mutation and review are separate owners', () => {
  const revise = getLoopCommand('revise')!
  const gate = getLoopCommand('revision-verify')!

  it('registers both halves of the revision pair', () => {
    expect(revise).toBeDefined()
    expect(gate).toBeDefined()
    expect(revise.ticketScope).toBe('all')
    expect(gate.ticketScope).toBe('all')
  })

  describe('revise (mutation only)', () => {
    it('still carries the user request and the smallest-change rule', () => {
      expect(revise.template).toContain('{{const:REVISION_REQUEST}}')
      expect(revise.template).toMatch(/SMALLEST change/)
    })

    it('no longer runs the reviewer itself', () => {
      expect(revise.template).not.toMatch(/sr-reviewer/)
      expect(revise.template).not.toMatch(/confidence-score\.json/)
      expect(revise.template).toMatch(/Do not re-grade your own work/i)
    })

    it('runs focused checks only — never the full gate or a health audit', () => {
      expect(revise.template).toMatch(/smallest focused test slice/i)
      expect(revise.template).toMatch(/Do not run the full project gate/i)
      expect(revise.template).not.toMatch(/health-check/i)
    })

    it('does not emit the sentinel, so the Decider reads only the gate verdict', () => {
      expect(revise.template).toMatch(/Do not emit a `VERIFICATION: PASS\|FAIL` sentinel/)
    })
  })

  describe('revision-verify (the single review + verification owner)', () => {
    it('is read-only and routes defects to the loop\'s separate fix step', () => {
      expect(gate.template).toMatch(/This gate is read-only/)
      expect(gate.template).toMatch(/do NOT fix findings/i)
      expect(gate.template).toMatch(/separate fix step/)
    })

    it('owns exactly ONE full-scope project gate and refuses to repeat it', () => {
      expect(gate.template).toMatch(/exactly ONE full-scope project gate/)
      expect(gate.template).toMatch(/DO NOT repeat them/)
    })

    it('runs the reviewer and asks for fresh confidence evidence', () => {
      expect(gate.template).toMatch(/sr-reviewer/)
      expect(gate.template).toMatch(/fresh `confidence-score\.json`/)
    })

    it('degrades honestly when the reviewer is unavailable', () => {
      expect(gate.template).toMatch(/reviewer is unavailable or inapplicable/)
      expect(gate.template).toMatch(/Never infer PASS from missing reviewer evidence/)
    })

    it('reconciles the reviewer Score/Verdict finish with the outer sentinel', () => {
      expect(gate.template).toMatch(/`Score:` and `Verdict:`/)
      expect(gate.template).toMatch(/intermediate reviewer result, not the end of your turn/)
    })

    it('excludes the repository-wide health audit the old double gate triggered', () => {
      expect(gate.template).toMatch(/Do not expand this into a general codebase health audit/)
      expect(gate.template).toMatch(/do not save a health snapshot/)
      expect(gate.template).not.toMatch(/health-check/i)
    })

    it('emits the sentinel the Decider and the review packet both read', () => {
      expect(gate.template).toMatch(/VERIFICATION: PASS/)
      expect(gate.template).toMatch(/VERIFICATION: FAIL — <short reason>/)
    })

    it('does not depend on the mutating agent\'s conversation', () => {
      expect(gate.template).toContain('{{const:REVISION_REQUEST}}')
      expect(gate.template).toMatch(/Do not depend on the mutating agent remembering/)
    })
  })
})
