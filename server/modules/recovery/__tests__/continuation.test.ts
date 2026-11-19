import { describe, expect, it } from 'vitest'
import { autoContinueVerdict, continuationGuidance, failureFingerprint, remainingAreHumanChecks, type FailureDiagnosis } from '..'

const diagnosis = (patch: Partial<FailureDiagnosis>): FailureDiagnosis => ({
  kind: 'crash', confidence: 'high', phase: 'developer', rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'core', ...patch,
})
const blocker = (kind: string, reason = 'pnpm is not installed', requiredAction = 'Install pnpm') => ({ kind, reason, command: 'pnpm', args: ['test'], cwd: '.', requiredAction })

describe('continuation guidance', () => {
  it('hands the next attempt the full stall reason with the reviewer findings, not the cut one-line detail', () => {
    const full = 'Automatic correction made no candidate changes. Host verification is valid: true. Acceptance policy: approved == true. Latest review findings: README.md must document the color option default (blue) with an example. Fixer diagnosis: nothing left to change'
    const text = continuationGuidance(diagnosis({ kind: 'blocked', detail: full.slice(0, 120) + '…' }), { completionReasons: [full, 'unverified'] })!
    expect(text).toContain('README.md must document the color option default')
    expect(text).toContain('Fixer diagnosis: nothing left to change')
    // Without the completion it still falls back to the detail.
    expect(continuationGuidance(diagnosis({ kind: 'blocked', detail: full.slice(0, 120) }))).toContain('Automatic correction made no candidate changes')
  })
  it('sends the exact unfinished tasks with the browser and install rule', () => {
    const text = continuationGuidance(diagnosis({ kind: 'incomplete_tasks', incompleteTasks: ['5.2 Visual review at 390px'] }))!
    expect(text).toContain('5.2 Visual review at 390px')
    expect(text).toContain('$SPECRAILS_BROWSE')
    expect(text).toMatch(/install it/i)
  })
  it('says what is missing and how to install it for a host blocker', () => {
    const text = continuationGuidance(diagnosis({ kind: 'environment', blocker: blocker('toolchain') }))!
    expect(text).toContain('pnpm is not installed')
    expect(text).toContain('`pnpm test`')
    expect(text).toContain('Install pnpm')
    expect(text).toMatch(/install it yourself/i)
    expect(text).toMatch(/credential, a secret/)
  })
  it('sends nothing for a transient provider error, a usage limit or an uncertain cause', () => {
    for (const kind of ['crash', 'timeout', 'tool_inactivity', 'provider_limit', 'tests_failed'] as const) expect(continuationGuidance(diagnosis({ kind }))).toBeNull()
    expect(continuationGuidance(diagnosis({ kind: 'incomplete_tasks', confidence: 'low' }))).toBeNull()
    expect(continuationGuidance(null)).toBeNull()
  })
  it('tells a stalled attempt to change approach, and a taken port to use $PORT', () => {
    expect(continuationGuidance(diagnosis({ kind: 'blocked', detail: 'Implementation attempt limit reached (3/3)' }))).toMatch(/change approach/)
    expect(continuationGuidance(diagnosis({ kind: 'blocked', detail: 'Baseline blocked' }))).toBeNull()
    expect(continuationGuidance(diagnosis({ kind: 'port_in_use', port: 5173 }))).toMatch(/5173[\s\S]*\$PORT/)
  })
  it('reads remaining tasks as person-only checks conservatively', () => {
    expect(remainingAreHumanChecks(['[human] confirm the live charge'])).toBe(true)
    expect(remainingAreHumanChecks(['Manual check on a real device'])).toBe(true)
    expect(remainingAreHumanChecks(['Screenshot the board at 390px'])).toBe(false)
    expect(remainingAreHumanChecks([])).toBe(false)
  })
})

describe('automatic continuation guards', () => {
  const verdict = (d: FailureDiagnosis | null, patch: Partial<Parameters<typeof autoContinueVerdict>[0]> = {}) =>
    autoContinueVerdict({ enabled: true, outcome: 'failed', diagnosis: d, chainAlreadyContinued: false, ...patch })

  it('never continues by itself a machine-wide install the person kept for themselves (it would ask again for nothing)', () => {
    const asked = { ...blocker('toolchain', 'terraform is missing', 'Run `brew install terraform` yourself, then continue the run.'), install: 'brew install terraform' }
    expect(verdict(diagnosis({ kind: 'environment', blocker: asked }))).toEqual({ continue: false, reason: 'person_must_resolve' })
    // The person's Continue tells the agent the install is theirs, never to run it.
    const text = continuationGuidance(diagnosis({ kind: 'environment', blocker: asked }))!
    expect(text).toContain('The person was asked to run `brew install terraform` themselves')
    expect(text).toContain('never install it machine-wide yourself')
    expect(text).not.toContain('install it yourself (project-local')
  })
  it('continues once for unfinished tasks, a missing tool, a transient error and a stall', () => {
    expect(verdict(diagnosis({ kind: 'incomplete_tasks', incompleteTasks: ['x'] }))).toEqual({ continue: true, reason: 'unfinished_tasks' })
    expect(verdict(diagnosis({ kind: 'environment', blocker: blocker('toolchain') }))).toEqual({ continue: true, reason: 'missing_tool' })
    expect(verdict(diagnosis({ kind: 'environment', blocker: blocker('setup', 'playwright browsers are missing', 'Run npx playwright install') }))).toEqual({ continue: true, reason: 'missing_tool' })
    for (const kind of ['crash', 'timeout', 'tool_inactivity'] as const) expect(verdict(diagnosis({ kind }))).toEqual({ continue: true, reason: 'transient_error' })
    expect(verdict(diagnosis({ kind: 'blocked', detail: 'Automatic correction made no candidate changes.' }))).toEqual({ continue: true, reason: 'stalled' })
  })

  it('never continues on credentials, secrets, policy, spend caps or a usage limit', () => {
    expect(verdict(diagnosis({ kind: 'environment', blocker: blocker('credential', 'npm registry returned 401', 'Log in to the registry') }))).toMatchObject({ continue: false, reason: 'person_must_resolve' })
    expect(verdict(diagnosis({ kind: 'environment', blocker: blocker('environment-variable', 'STRIPE_SECRET_KEY is not set', 'Set it') }))).toMatchObject({ continue: false, reason: 'person_must_resolve' })
    expect(verdict(diagnosis({ kind: 'environment', blocker: blocker('scope', 'write outside the repository', 'Allow it') }))).toMatchObject({ continue: false })
    expect(verdict(diagnosis({ kind: 'crash', detail: 'Denied by the policy: rm -rf' }))).toMatchObject({ continue: false, reason: 'person_must_resolve' })
    expect(verdict(diagnosis({ kind: 'provider_limit' }))).toMatchObject({ continue: false, reason: 'person_must_resolve' })
    expect(verdict(diagnosis({ kind: 'blocked', detail: null }), { outcome: 'max-cost' })).toMatchObject({ continue: false, reason: 'not_failed' })
    expect(verdict(diagnosis({ kind: 'environment', blocker: null, detail: 'Developer reported a host blocker' }))).toMatchObject({ continue: false })
  })

  it('never continues a stop, an unknown cause, a repeat, a second time, or with the setting off', () => {
    const tasks = diagnosis({ kind: 'incomplete_tasks', incompleteTasks: ['x'] })
    expect(verdict(tasks, { outcome: 'stopped' })).toMatchObject({ continue: false, reason: 'not_failed' })
    expect(verdict(diagnosis({ kind: 'unknown', confidence: 'low' }))).toMatchObject({ continue: false, reason: 'unknown_cause' })
    expect(verdict(null)).toMatchObject({ continue: false, reason: 'unknown_cause' })
    expect(verdict(tasks, { chainAlreadyContinued: true })).toMatchObject({ continue: false, reason: 'already_continued' })
    expect(verdict(tasks, { previous: { ...tasks } })).toMatchObject({ continue: false, reason: 'repeated_failure' })
    expect(verdict(tasks, { enabled: false })).toMatchObject({ continue: false, reason: 'disabled' })
    expect(verdict(diagnosis({ kind: 'tests_failed' }))).toMatchObject({ continue: false, reason: 'not_auto_fixable' })
    expect(verdict(diagnosis({ kind: 'spec_invalid' }))).toMatchObject({ continue: false })
  })

  it('fingerprints the same failure the same way, ignoring counters', () => {
    expect(failureFingerprint(diagnosis({ detail: 'attempt 2 of 3 crashed' }))).toBe(failureFingerprint(diagnosis({ detail: 'attempt 3 of 3 crashed' })))
    expect(failureFingerprint(diagnosis({ phase: 'reviewer' }))).not.toBe(failureFingerprint(diagnosis({ phase: 'developer' })))
  })
})
