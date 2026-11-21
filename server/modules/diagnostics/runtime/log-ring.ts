/**
 * The server's own recent output, kept in memory for "Report a problem".
 *
 * In the desktop app stdout/stderr also reach the host's sidecar.log; in the
 * browser build (`npm run dev`) this ring is the only copy. Lines are
 * timestamped when they are written and bounded by total size; nothing is
 * persisted and redaction happens when a report is built.
 */
export interface LogRing {
  push(stream: 'out' | 'err', chunk: unknown): void
  text(): string
}

export function createLogRing(options: { maxChars?: number; now?: () => number } = {}): LogRing {
  const maxChars = options.maxChars ?? 1024 * 1024
  const now = options.now ?? Date.now
  const lines: string[] = []
  let size = 0
  const pending: Record<'out' | 'err', string> = { out: '', err: '' }
  const add = (line: string) => {
    lines.push(line)
    size += line.length + 1
    while (size > maxChars && lines.length > 1) size -= (lines.shift() as string).length + 1
  }
  return {
    push(stream, chunk) {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : ''
      if (!text) return
      const parts = (pending[stream] + text).split('\n')
      pending[stream] = (parts.pop() ?? '').slice(-8192)
      const stamp = new Date(now()).toISOString()
      for (const part of parts) add(`${stamp} [${stream.toUpperCase()}] ${part.replace(/\r$/, '').slice(0, 8192)}`)
    },
    text() {
      const open = (['out', 'err'] as const).filter(stream => pending[stream]).map(stream => `${new Date(now()).toISOString()} [${stream.toUpperCase()}] ${pending[stream]}`)
      return [...lines, ...open].join('\n') + (lines.length || open.length ? '\n' : '')
    },
  }
}

type Writable = Pick<NodeJS.WriteStream, 'write'>

/** Mirror writes of `stdout`/`stderr` into `ring`. Returns the uninstaller. */
export function captureProcessOutput(ring: LogRing, streams: { out: Writable; err: Writable } = { out: process.stdout, err: process.stderr }): () => void {
  const restore: Array<() => void> = []
  for (const name of ['out', 'err'] as const) {
    const stream = streams[name]
    const original = stream.write
    stream.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      try { ring.push(name, chunk) } catch { /* capture must never break logging */ }
      return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest)
    } as Writable['write']
    restore.push(() => { stream.write = original })
  }
  return () => { for (const undo of restore) undo() }
}
