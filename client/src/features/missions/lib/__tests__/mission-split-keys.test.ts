import { describe, expect, it } from 'vitest'
import { missionSplitCommand } from '../mission-split-keys'

const key = (over: Partial<KeyboardEvent>) => ({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, code: '', key: '', ...over }) as KeyboardEvent

describe('missionSplitCommand', () => {
  it('reads ⌥⌘ chords and ⌘⇧↵ on macOS by physical key', () => {
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, code: 'BracketRight', key: '‘' }), true)).toBe('focus-next')
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, code: 'BracketLeft' }), true)).toBe('focus-previous')
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, code: 'Equal' }), true)).toBe('equalize')
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, code: 'KeyW' }), true, true)).toBe('close')
    expect(missionSplitCommand(key({ metaKey: true, shiftKey: true, key: 'Enter' }), true, true)).toBe('maximize')
  })
  it('leaves Back/Forward, the run strip and other chords alone', () => {
    expect(missionSplitCommand(key({ metaKey: true, code: 'BracketLeft' }), true)).toBeNull()
    expect(missionSplitCommand(key({ altKey: true, code: 'BracketLeft' }), true)).toBeNull()
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, code: 'KeyB' }), true)).toBeNull()
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, shiftKey: true, code: 'KeyW' }), true)).toBeNull()
    expect(missionSplitCommand(key({ metaKey: true, shiftKey: true, key: 'A' }), true)).toBeNull()
    expect(missionSplitCommand(key({ ctrlKey: true, altKey: true, code: 'KeyW' }), true)).toBeNull()
  })
  it('uses Ctrl elsewhere and ignores Ctrl+Alt (AltGr) while typing', () => {
    expect(missionSplitCommand(key({ ctrlKey: true, altKey: true, code: 'KeyW' }), false)).toBe('close')
    expect(missionSplitCommand(key({ ctrlKey: true, altKey: true, code: 'KeyW' }), false, true)).toBeNull()
    expect(missionSplitCommand(key({ ctrlKey: true, shiftKey: true, key: 'Enter' }), false, true)).toBe('maximize')
    expect(missionSplitCommand(key({ metaKey: true, altKey: true, code: 'KeyW' }), false)).toBeNull()
  })
})
