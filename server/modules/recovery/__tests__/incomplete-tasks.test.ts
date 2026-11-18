import { describe, expect, it } from 'vitest'
import { deriveFailureDiagnosis, incompleteTasksOf, parseCoreFailure, rankRemedies } from '../domain'
import { markRemainingAsHumanChecks } from '../../delivery/runtime/incomplete-tasks-remedy'

// The completion reason a real Implement run (tetrisex #14) ended with.
const STALLED = 'The developer made no changes while approved tasks are still incomplete. Incomplete: ["4.1 README: the visual-review note needs a manual browser check [desktop]"]. Developer summary: 8 of 9 tasks are done; the environment has no browser.'

describe('incomplete tasks diagnosis', () => {
  it('names the cause and the unfinished tasks even when Core sent an unknown, low-confidence record', () => {
    const diagnosis = deriveFailureDiagnosis({ outcome: 'failed', core: { kind: 'unknown', confidence: 'low', phase: 'implementation-stalled' }, blockedReason: STALLED })
    expect(diagnosis).toMatchObject({ kind: 'incomplete_tasks', confidence: 'high', phase: 'implementation-stalled', source: 'desktop',
      incompleteTasks: ['4.1 README: the visual-review note needs a manual browser check [desktop]'] })
    expect(rankRemedies(diagnosis)).toEqual(['continue-to-review', 'retry-with-browser', 'open-logs', 'retry'])
  })
  it('keeps Core 5.15\'s own record with its task list', () => {
    const core = { kind: 'incomplete_tasks', confidence: 'high', phase: 'implementation-stalled', incompleteTasks: ['4.1 Write the note'], detail: 'x' }
    expect(parseCoreFailure(core)).toMatchObject({ kind: 'incomplete_tasks', incompleteTasks: ['4.1 Write the note'], source: 'core' })
    expect(deriveFailureDiagnosis({ outcome: 'failed', core, blockedReason: STALLED })).toMatchObject({ source: 'core', incompleteTasks: ['4.1 Write the note'] })
  })
  it('maps every Implement end reason to a known kind instead of an unknown cause', () => {
    const cases: Array<[string, string]> = [
      ['Implementation attempt limit reached (3/3) with approved tasks still incomplete after 2 unblock attempt(s). Incomplete: []. Unblock summary: x', 'incomplete_tasks'],
      ['The plan for change c still fails OpenSpec validation or the plan contract after 2 repair(s), so it was not implemented.', 'spec_invalid'],
      ['OpenSpec could not archive change c. The implementation was verified and reviewed.', 'spec_invalid'],
      ['Automatic correction made no candidate changes. Host verification is valid: true.', 'blocked'],
      ['Automatic correction limit reached (3/3). Acceptance policy: approved == true', 'blocked'],
      ['Developer reported a host blocker (credential): log in to the registry Evidence: 401', 'environment'],
      ['Unblock reported a host blocker (network): allow the registry Evidence: ENOTFOUND', 'environment'],
      ['Host blocker (toolchain): docker is missing Required action: install Docker', 'environment'],
    ]
    for (const [reason, kind] of cases) expect(deriveFailureDiagnosis({ outcome: 'failed', blockedReason: reason }).kind, reason).toBe(kind)
    expect(rankRemedies({ kind: 'spec_invalid', confidence: 'high', resumablePhase: null })).toEqual(['edit-spec', 'open-logs', 'retry'])
    // Still no invented cause.
    expect(deriveFailureDiagnosis({ outcome: 'failed', blockedReason: 'something new' })).toMatchObject({ kind: 'unknown', confidence: 'low' })
  })
  it('reads the list even when a task text contains a bracket, and nothing from prose', () => {
    expect(incompleteTasksOf(STALLED)).toEqual(['4.1 README: the visual-review note needs a manual browser check [desktop]'])
    expect(incompleteTasksOf('Incomplete: none')).toBeNull()
  })
})

describe('continue to review: remaining tasks become human checks', () => {
  const tasks = '## 1\n- [x] 1.1 Add cinematic.js\n- [ ] 4.1 README: visual-review note\n- [ ] 4.2 [human] Judge the glow on a phone\n  - [ ] nested detail\n'
  it('tags them on a Core that understands the tag, listing every check', () => {
    expect(markRemainingAsHumanChecks(tasks, 'tag')).toEqual({
      text: '## 1\n- [x] 1.1 Add cinematic.js\n- [ ] 4.1 [human] README: visual-review note\n- [ ] 4.2 [human] Judge the glow on a phone\n  - [ ] [human] nested detail\n',
      checks: ['4.1 README: visual-review note', '4.2 Judge the glow on a phone', 'nested detail'],
    })
  })
  it('ticks them on an older Core, keeping the description unchanged', () => {
    const { text, checks } = markRemainingAsHumanChecks(tasks, 'tick')
    expect(text).toContain('- [x] 4.1 README: visual-review note')
    expect(text).not.toContain('- [ ]')
    expect(checks).toHaveLength(3)
  })
})
