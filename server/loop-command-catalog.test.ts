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
  it('ships implement (all), batch (all), ultracode (per-ticket, claude-only)', () => {
    expect(getLoopCommand('implement')).toMatchObject({ coreCommand: 'implement', ticketScope: 'all' })
    expect(getLoopCommand('batch')).toMatchObject({ coreCommand: 'batch-implement', ticketScope: 'all' })
    expect(getLoopCommand('ultracode')).toMatchObject({ native: true, claudeOnly: true, ticketScope: 'per-ticket' })
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

  it('ultracode expands to a raw autonomous prompt, NOT a slash command', () => {
    const out = expandCommands('{{cmd:ultracode}}', { provider: 'claude', ticketIds: [5] })
    expect(out).toContain('autonomously')
    expect(out).toContain('{{spec.title}}') // spec tokens survive for the data pass
    expect(out).not.toContain('/specrails:')
    expect(out).not.toContain('#5')
  })

  it('collapses unknown commands to empty', () => {
    expect(expandCommands('x {{cmd:bogus}} y', { provider: 'claude' })).toBe('x  y')
  })

  it('dominantTicketScope reads the command scope', () => {
    expect(dominantTicketScope('{{cmd:implement}}')).toBe('all')
    expect(dominantTicketScope('{{cmd:batch}}')).toBe('all')
    expect(dominantTicketScope('{{cmd:ultracode}}')).toBe('per-ticket')
    expect(dominantTicketScope('plain prompt, no command')).toBe('per-ticket')
  })

  it('referencesClaudeOnlyCommand flags ultracode only', () => {
    expect(referencesClaudeOnlyCommand('{{cmd:ultracode}}')).toBe(true)
    expect(referencesClaudeOnlyCommand('{{cmd:implement}}')).toBe(false)
  })

  it('command-then-spec resolves end-to-end with all ticket ids', () => {
    const out = interpolateSpec(
      expandCommands('{{cmd:implement}}', { provider: 'claude', ticketIds: [1, 2] }),
      { ticketIds: [1, 2], title: 'X' }
    )
    expect(out).toBe('/specrails:implement #1 #2 --yes')
    expect(out).not.toContain('{{')
  })
})
