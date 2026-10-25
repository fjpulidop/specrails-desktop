import { afterEach, describe, expect, it } from 'vitest'
import { defaultSampleFolder, readSampleStatus, sampleBilling, type SamplePreset } from '../lib/sample-model'
import { SAMPLE_GUIDE_KEY, readGuideState, writeGuideState } from '../lib/sample-guide-state'

const preset = (over: Partial<SamplePreset> = {}): SamplePreset => ({ provider: 'claude', model: 'haiku', local: false, loopId: 'factory:sdd-quick-openspec', runCapUsd: 1, ...over })

describe('readSampleStatus', () => {
  it('reads a ready answer with its preset, local alternative and estimate', () => {
    const status = readSampleStatus({
      catalog: [{ id: 'tic-tac-toe', name: 'tic-tac-toe', specCount: 3 }],
      sample: { sampleId: 'tic-tac-toe', projectId: 'p1', path: '/h/s', specIds: [1, 2, 3] },
      defaultParentDir: '/h/Specrails Samples',
      launch: { ready: true, preset: preset(), localPreset: preset({ provider: 'local-lan', model: 'qwen', local: true, runCapUsd: null }), estimate: { minutes: [3, 5], usd: [0.3, 1] }, runCapUsd: 1 },
    })
    expect(status?.launch).toMatchObject({ ready: true, preset: { model: 'haiku', runCapUsd: 1 }, localPreset: { local: true, runCapUsd: null } })
    expect(status?.sample?.specIds).toEqual([1, 2, 3])
  })

  it('treats an unreadable launch as not ready (never a crash) and keeps a safe estimate', () => {
    const status = readSampleStatus({ catalog: [], sample: null, launch: { ready: true, preset: { provider: 1 } } })
    expect(status?.launch).toMatchObject({ ready: false, reason: 'no_provider', estimate: { minutes: [3, 5], usd: [0.3, 1] }, runCapUsd: 1 })
    expect(readSampleStatus(null)).toBeNull()
    expect(readSampleStatus({ launch: { ready: false, reason: 'not_signed_in' } })?.launch).toMatchObject({ ready: false, reason: 'not_signed_in' })
  })
})

describe('sampleBilling', () => {
  it('only a positively metered provider licenses a dollar figure', () => {
    expect(sampleBilling(preset({ local: true }), { ready: true, plan: false, metered: false })).toBe('local')
    expect(sampleBilling(preset(), { ready: true, plan: true, metered: false })).toBe('plan')
    expect(sampleBilling(preset(), { ready: true, plan: false, metered: true })).toBe('metered')
    expect(sampleBilling(preset(), { ready: false, plan: false, metered: false })).toBe('unknown')
    expect(sampleBilling(preset(), { ready: true, plan: false, metered: false })).toBe('unknown')
  })
})

describe('defaultSampleFolder', () => {
  it('joins with the host separator', () => {
    expect(defaultSampleFolder('/h/Specrails Samples', 'tic-tac-toe')).toBe('/h/Specrails Samples/tic-tac-toe')
    expect(defaultSampleFolder('C:\\Users\\me\\Specrails Samples', 'tic-tac-toe')).toBe('C:\\Users\\me\\Specrails Samples\\tic-tac-toe')
    expect(defaultSampleFolder('', 'tic-tac-toe')).toBe('tic-tac-toe')
  })
})

describe('guide state (per viewer)', () => {
  afterEach(() => { localStorage.clear() })

  it('starts fresh, persists per project and clamps a corrupt step', () => {
    expect(readGuideState('p1')).toEqual({ projectId: 'p1', step: 0, done: false, launched: false })
    writeGuideState({ projectId: 'p1', step: 2, done: true, launched: true })
    expect(readGuideState('p1')).toEqual({ projectId: 'p1', step: 2, done: true, launched: true })
    expect(readGuideState('p2')).toMatchObject({ step: 0, done: false })
    localStorage.setItem(SAMPLE_GUIDE_KEY, JSON.stringify({ projectId: 'p1', step: 99, done: false }))
    expect(readGuideState('p1').step).toBe(2)
    localStorage.setItem(SAMPLE_GUIDE_KEY, '{nope')
    expect(readGuideState('p1')).toMatchObject({ step: 0, done: false })
  })

  it('works when storage is blocked', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    try { expect(readGuideState('p1')).toMatchObject({ step: 0, done: false }) } finally { Storage.prototype.getItem = original }
    expect(() => writeGuideState({ projectId: 'p1', step: 1, done: false, launched: false })).not.toThrow()
  })
})
