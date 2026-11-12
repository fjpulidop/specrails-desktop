import { describe, it, expect } from 'vitest'
import { resolveMissionProjectSwitch } from './resolve-mission-project-switch'

const projects = [{ id: 'a' }, { id: 'b' }]

describe('resolveMissionProjectSwitch', () => {
  it('[spec:mission-project-follow/selecting-a-mission-activates-its-pinned-project] returns the pinned project when it is registered and differs from the active one', () => {
    expect(resolveMissionProjectSwitch('b', 'a', projects)).toBe('b')
  })

  it('[spec:mission-project-follow/selecting-a-mission-activates-its-pinned-project] returns the pinned project when no project is active', () => {
    expect(resolveMissionProjectSwitch('b', null, projects)).toBe('b')
  })

  it('[spec:mission-project-follow/selection-leaves-the-project-unchanged-when-there-is-nothing-to-switch-to] returns null when the pin is the active project', () => {
    expect(resolveMissionProjectSwitch('a', 'a', projects)).toBeNull()
  })

  it.each([null, undefined, ''])('returns null for an unpinned mission (%s)', (pin) => {
    expect(resolveMissionProjectSwitch(pin, 'a', projects)).toBeNull()
  })

  it('[spec:mission-project-follow/selection-leaves-the-project-unchanged-when-there-is-nothing-to-switch-to] returns null when the pinned project is not registered', () => {
    expect(resolveMissionProjectSwitch('gone', 'a', projects)).toBeNull()
  })
})
