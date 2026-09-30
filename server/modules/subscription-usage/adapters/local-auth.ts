import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { UsageError } from './errors'
export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex')
/** Bounded read; never expose auth bytes or paths in errors. */
export async function readAuthFile(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new UsageError('credentials-unreadable')
    const buffer = Buffer.alloc(1024 * 1024 + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 1024 * 1024) throw new UsageError('credentials-unreadable')
    return buffer.toString('utf8', 0, bytesRead)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new UsageError('credentials-unreadable')
  } finally { await handle?.close() }
}
export async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new UsageError('invalid-response', true)
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024 * 1024) throw new UsageError('invalid-response', true)
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new UsageError('invalid-response', true) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
