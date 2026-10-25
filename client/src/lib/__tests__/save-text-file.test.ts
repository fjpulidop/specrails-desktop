import { afterEach, describe, expect, it, vi } from 'vitest'

const isTauri = vi.hoisted(() => vi.fn(() => false))
vi.mock('../tauri-shell', () => ({ isTauri }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { saveTextFile } from '../save-text-file'

afterEach(() => { vi.clearAllMocks(); isTauri.mockReturnValue(false) })

describe('saveTextFile', () => {
  it('asks the host to save in the desktop shell and distinguishes a dismissed dialog', async () => {
    isTauri.mockReturnValue(true)
    invoke.mockResolvedValueOnce(true)
    expect(await saveTextFile('a.md', 'x')).toBe('saved')
    expect(invoke).toHaveBeenCalledWith('desktop_save_text', { suggestedName: 'a.md', text: 'x' })
    invoke.mockResolvedValueOnce(false)
    expect(await saveTextFile('a.md', 'x')).toBe('cancelled')
    invoke.mockRejectedValueOnce(new Error('boom'))
    expect(await saveTextFile('a.md', 'x')).toBe('failed')
  })

  it('falls back to an anchor download in a browser', async () => {
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    expect(await saveTextFile('a.html', '<p>x</p>', 'text/html')).toBe('saved')
    expect(create).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledWith('blob:x')
    click.mockRestore()
  })
})
