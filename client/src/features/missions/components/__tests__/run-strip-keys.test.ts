import { describe, it, expect, afterEach } from 'vitest'
import { isTextEntry, registerRunStrip, resolveRunStrip, runStripCommand, stripKeyCode, type RunStripHandle } from '../run-strip-keys'

const key = (code: string, mods: Partial<Record<'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey', boolean>> = {}) =>
  ({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, code, ...mods })

describe('runStripCommand', () => {
  it('matches Option/Alt alone by physical key (Option-layer characters never change the binding)', () => {
    expect(runStripCommand(key('KeyR', { altKey: true }))).toBe('focus')
    expect(runStripCommand(key('BracketLeft', { altKey: true }))).toBe('previous')
    expect(runStripCommand(key('BracketRight', { altKey: true }))).toBe('next')
  })

  it('leaves plain keys and Cmd/Ctrl/Shift combinations (⌥⌘B, ⌘K, AltGr) to the rest of the app', () => {
    expect(runStripCommand(key('KeyR'))).toBeNull()
    expect(runStripCommand(key('KeyR', { altKey: true, metaKey: true }))).toBeNull()
    expect(runStripCommand(key('KeyR', { altKey: true, ctrlKey: true }))).toBeNull()
    expect(runStripCommand(key('KeyR', { altKey: true, shiftKey: true }))).toBeNull()
    expect(runStripCommand(key('KeyB', { altKey: true }))).toBeNull()
  })
})

describe('isTextEntry / stripKeyCode', () => {
  it('recognizes fields and contenteditable editors', () => {
    const input = document.createElement('input')
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editor.appendChild(inner)
    const off = document.createElement('div')
    off.setAttribute('contenteditable', 'false')
    expect(isTextEntry(input)).toBe(true)
    expect(isTextEntry(inner)).toBe(true)
    expect(isTextEntry(off)).toBe(false)
    expect(isTextEntry(document.createElement('button'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })

  it('maps a claimed letter to its physical key', () => {
    expect(stripKeyCode('p')).toBe('KeyP')
    expect(stripKeyCode('H')).toBe('KeyH')
  })
})

describe('resolveRunStrip (several missions visible)', () => {
  const surface = () => {
    const el = document.createElement('section')
    el.setAttribute('data-mission-surface', '')
    document.body.appendChild(el)
    return el
  }
  afterEach(() => { document.body.innerHTML = '' })

  it('picks the mission containing focus, else the most recently focused, else the most recently mounted', () => {
    const a = surface()
    const b = surface()
    const inB = document.createElement('button')
    b.appendChild(inB)
    const ha = { surface: () => a }
    const hb = { surface: () => b }
    expect(resolveRunStrip([{ handle: ha, focusedAt: 5, mountedAt: 1 }, { handle: hb, focusedAt: 1, mountedAt: 2 }], inB)).toBe(hb)
    expect(resolveRunStrip([{ handle: ha, focusedAt: 5, mountedAt: 1 }, { handle: hb, focusedAt: 1, mountedAt: 2 }], document.body)).toBe(ha)
    expect(resolveRunStrip([{ handle: ha, focusedAt: 0, mountedAt: 1 }, { handle: hb, focusedAt: 0, mountedAt: 2 }], null)).toBe(hb)
  })

  it('ignores detached missions', () => {
    const detached = document.createElement('section')
    expect(resolveRunStrip([{ handle: { surface: () => detached }, focusedAt: 9, mountedAt: 9 }], null)).toBeNull()
  })

  it('routes ⌥R to the strip of the mission the person is in, through one app-wide listener', () => {
    const a = surface()
    const b = surface()
    const fieldA = document.createElement('input')
    a.appendChild(fieldA)
    const calls: string[] = []
    const handle = (name: string, el: Element): RunStripHandle => ({
      surface: () => el, hasRuns: () => true, hasFocus: () => false,
      focus: () => { calls.push(`${name}:focus`) }, togglePanel: () => { calls.push(`${name}:toggle`) }, cycle: (d) => { calls.push(`${name}:cycle${d}`) },
    })
    const offA = registerRunStrip(handle('a', a))
    const offB = registerRunStrip(handle('b', b))
    fieldA.focus()
    fieldA.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', altKey: true, bubbles: true, cancelable: true }))
    // Bracket keys keep typing in a field.
    fieldA.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', altKey: true, bubbles: true, cancelable: true }))
    // Outside any field and any mission: the most recently focused mission (a).
    fieldA.blur()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', altKey: true, bubbles: true, cancelable: true }))
    offA()
    offB()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', altKey: true, bubbles: true, cancelable: true }))
    expect(calls).toEqual(['a:focus', 'a:cycle1'])
  })
})
