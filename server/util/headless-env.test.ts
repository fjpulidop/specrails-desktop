import { describe, expect, it } from 'vitest'
import { headlessJobEnv, withHeadlessContract } from './headless-env'

describe('headless contract', () => {
  it('marks agent processes headless without mutating the source', () => {
    const source = { PATH: '/bin' }
    expect(withHeadlessContract(source)).toEqual({ PATH: '/bin', SPECRAILS_HEADLESS: '1' })
    expect(source).toEqual({ PATH: '/bin' })
  })
  it('keeps an explicit value, including the opt-out', () => {
    const optOut = { SPECRAILS_HEADLESS: '0' }
    expect(withHeadlessContract(optOut)).toBe(optOut)
    expect(headlessJobEnv(optOut)).toEqual({ SPECRAILS_HEADLESS: '0' })
  })
  it('stops browser auto-open for jobs Desktop spawns without Core', () => {
    expect(headlessJobEnv({ BROWSER: 'firefox' })).toEqual({ BROWSER: 'none', SPECRAILS_HEADLESS: '1' })
  })
})
