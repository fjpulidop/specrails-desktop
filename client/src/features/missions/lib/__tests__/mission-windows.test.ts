import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMissionWindowRoute, missionWindowBridge, validateMissionWindowSnapshot, type MissionWindowSnapshot } from '../mission-windows'

const valid = (): MissionWindowSnapshot => ({ version: 1, projectId: null, conversationId: 'global', capturedAt: 1,
  composer: { text: 'hello', references: [], attachments: [] }, scroll: null,
  workspace: { codePaneOpen: false, jobsPaneOpen: false, analyticsPaneOpen: false, browserOpen: false, pendingCaptures: [] },
})
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })
describe('mission window bridge boundaries', () => {
  it('supports Home mission snapshots and isolates object mutations', () => {
    const input = valid()
    const copy = validateMissionWindowSnapshot(input, input)
    copy.composer.text = 'changed'
    expect(input.composer.text).toBe('hello')
  })
  it('rejects unknown versions, changed project ownership, invalid references and nonfinite scroll state', () => {
    expect(() => validateMissionWindowSnapshot({ ...valid(), version: 2 }, valid())).toThrow()
    expect(() => validateMissionWindowSnapshot({ ...valid(), projectId: 'foreign' }, valid())).toThrow()
    expect(() => validateMissionWindowSnapshot({ ...valid(), scroll: { top: Infinity } }, valid())).toThrow()
    expect(() => validateMissionWindowSnapshot({ ...valid(), composer: { ...valid().composer, references: [{ start: 9, end: 12 }] } }, valid())).toThrow()
    expect(() => validateMissionWindowSnapshot({ ...valid(), composer: { ...valid().composer, submission: { signature: 'text', queueId: '' } } }, valid())).toThrow(/retry identity/)
  })
  it('rejects oversized UTF-8 state instead of dropping text or attachment descriptors', () => {
    const input = valid(); input.composer.text = '漢'.repeat(800_000)
    expect(() => validateMissionWindowSnapshot(input, input)).toThrow(/transfer limit/)
  })
  it('remains a no-op outside the native app and does not trust a query parameter alone', async () => {
    window.history.replaceState(null, '', '/?missionWindow=1')
    expect(isMissionWindowRoute()).toBe(false)
    expect(await missionWindowBridge.supported()).toBe(false)
    expect(await missionWindowBridge.current()).toBeNull()
    expect(await missionWindowBridge.list()).toEqual([])
    expect(await missionWindowBridge.focus('global')).toBe(false)
    await missionWindowBridge.discard('global')
    await missionWindowBridge.cancel('label', 1)
    expect(await missionWindowBridge.listen(vi.fn())).toBeTypeOf('function')
    await expect(missionWindowBridge.detach(valid(), valid())).rejects.toThrow(/unavailable/)
  })
})
