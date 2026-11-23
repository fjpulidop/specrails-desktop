import { describe, expect, it } from 'vitest'
import { deriveFailureDiagnosis } from '../domain'

describe('stalled correction detail from Core', () => {
  it('keeps the reviewer issue Core names instead of cutting it at 280 characters', () => {
    const issue = 'No host verification covers the criterion "package must still build for the iOS Simulator with xcodebuild". Only swift test was run. Missing command, from the repository root: xcodebuild -scheme Habits -destination generic/platform=iOS Simulator build'
    const detail = `Automatic correction changed nothing. The reviewer still asks for: ${issue}. Fixer: the review rejected only for host evidence; no file change can add it.`
    const d = deriveFailureDiagnosis({ outcome: 'failed', core: { kind: 'blocked', confidence: 'high', phase: 'correction-stalled', detail } })
    expect(d).toMatchObject({ kind: 'blocked', confidence: 'high', source: 'core' })
    expect(d.detail).toBe(detail)
  })
})
