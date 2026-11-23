import { describe, it, expect, vi, beforeEach } from 'vitest'

const open = vi.fn()
vi.mock('node:fs/promises', () => ({ open: (...args: unknown[]) => open(...args) }))

import { readAuthFile } from './local-auth'

const fsError = (code: string) => Object.assign(new Error(code), { code })

describe('readAuthFile', () => {
  beforeEach(() => open.mockReset())

  it('treats a missing file as signed out', async () => {
    open.mockRejectedValueOnce(fsError('ENOENT'))
    await expect(readAuthFile('auth.json')).resolves.toBeNull()
  })

  it.each(['EBUSY', 'EPERM', 'EACCES'])('retries a file the CLI holds locked (%s on Windows)', async (code) => {
    open.mockRejectedValueOnce(fsError(code))
    await expect(readAuthFile('auth.json')).rejects.toMatchObject({ code: 'credentials-unreadable', retryable: true })
  })

  it('does not retry any other read failure', async () => {
    open.mockRejectedValueOnce(fsError('EISDIR'))
    await expect(readAuthFile('auth.json')).rejects.toMatchObject({ code: 'credentials-unreadable', retryable: false })
  })
})
