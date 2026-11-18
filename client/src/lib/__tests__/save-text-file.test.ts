import { afterEach, describe, expect, it, vi } from 'vitest'

const isTauri = vi.hoisted(() => vi.fn(() => false))
vi.mock('../tauri-shell', () => ({ isTauri }))
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { saveBinaryFile, saveTextFile } from '../save-text-file'

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

describe('saveBinaryFile', () => {
  it('sends the bytes as the raw IPC body with an encoded file name', async () => {
    isTauri.mockReturnValue(true)
    invoke.mockResolvedValueOnce(true)
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4])
    expect(await saveBinaryFile('informe ñ.zip', bytes)).toBe('saved')
    expect(invoke).toHaveBeenCalledWith('desktop_save_bytes', bytes, { headers: { 'x-specrails-suggested-name': 'informe%20%C3%B1.zip' } })
    invoke.mockResolvedValueOnce(false)
    expect(await saveBinaryFile('a.zip', bytes)).toBe('cancelled')
    invoke.mockRejectedValueOnce(new Error('denied'))
    expect(await saveBinaryFile('a.zip', bytes)).toBe('failed')
  })

  it('downloads a Blob in a browser', async () => {
    const create = vi.fn((_blob: Blob) => 'blob:zip')
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    expect(await saveBinaryFile('r.zip', new Uint8Array([1, 2, 3]), 'application/zip')).toBe('saved')
    const blob = create.mock.calls[0][0]
    expect(blob.type).toBe('application/zip')
    expect(blob.size).toBe(3)
    click.mockRestore()
  })
})

