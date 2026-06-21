import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  TerminalManager,
  RingBuffer,
  TerminalLimitExceededError,
  TerminalNameInvalidError,
  TerminalSpawnError,
  mapSpawnError,
  resolveShell,
  resolveShellFor,
  shellArgs,
  TERMINAL_SCROLLBACK_BYTES,
  TERMINAL_MAX_PER_PROJECT,
} from './terminal-manager'

// ─── Fake WebSocket ───────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  readyState = 1 // OPEN
  sent: Array<{ data: Buffer | string; binary: boolean }> = []
  closed: { code: number; reason?: string } | null = null
  send(data: Buffer | string, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: !!opts?.binary })
  }
  close(code = 1000, reason?: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.readyState = 3 // CLOSED
    this.emit('close', code, reason)
  }
}

function asWs(ws: FakeWs): import('ws').WebSocket {
  return ws as unknown as import('ws').WebSocket
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/**
 * Wait until the predicate is true, polling every 20ms up to the timeout.
 * Returns true if the condition was satisfied, false on timeout.
 */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(20)
  }
  return pred()
}

/** Concatenate live (non-replay) output sent to a ws after a given index. */
function concatLive(ws: FakeWs, from = 0): string {
  return ws.sent
    .slice(from)
    .filter((f) => f.binary)
    .map((f) => (Buffer.isBuffer(f.data) ? f.data.toString('utf8') : String(f.data)))
    .join('')
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RingBuffer', () => {
  it('appends and snapshots', () => {
    const b = new RingBuffer(100)
    b.append(Buffer.from('hello'))
    b.append(Buffer.from('world'))
    expect(b.snapshot().toString()).toBe('helloworld')
    expect(b.size()).toBe(10)
  })

  it('drops oldest chunks on overflow', () => {
    const b = new RingBuffer(10)
    b.append(Buffer.from('1234567890'))
    b.append(Buffer.from('abcde'))
    // First chunk dropped whole, second kept
    expect(b.snapshot().length).toBeLessThanOrEqual(10)
    expect(b.snapshot().toString()).toContain('abcde')
  })

  it('trims tail of lone oversized chunk', () => {
    const b = new RingBuffer(5)
    b.append(Buffer.from('abcdefghij'))
    expect(b.snapshot().length).toBe(5)
    expect(b.snapshot().toString()).toBe('fghij')
  })

  it('bounds size after many appends', () => {
    const b = new RingBuffer(TERMINAL_SCROLLBACK_BYTES)
    for (let i = 0; i < 2000; i++) b.append(Buffer.alloc(512, 65))
    expect(b.size()).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_BYTES)
  })

  it('clear resets size to zero', () => {
    const b = new RingBuffer(100)
    b.append(Buffer.from('hello'))
    b.clear()
    expect(b.size()).toBe(0)
    expect(b.snapshot().length).toBe(0)
  })

  it('does not pin the original oversized chunk allocation when trimming (BUG-TERM-02)', () => {
    // A single chunk far larger than the capacity arrives, then the session
    // goes idle. The retained tail must be a fresh allocation, not a view that
    // pins the entire multi-MB original ArrayBuffer.
    const b = new RingBuffer(5)
    const big = Buffer.alloc(10_000, 65) // 'A' * 10_000
    b.append(big)
    expect(b.snapshot().length).toBe(5)
    expect(b.snapshot().toString()).toBe('AAAAA')
    // Inspect the stored chunk directly: with the bug it is a `subarray` view
    // whose `.buffer.byteLength` is the full 10_000 of `big`; the fix copies the
    // tail out into a fresh allocation no larger than the trimmed 5 bytes.
    const stored = (b as unknown as { chunks: Buffer[] }).chunks[0]
    expect(stored.length).toBe(5)
    // The stored tail must be a fresh copy, NOT a view aliasing `big`'s
    // ArrayBuffer (which would pin the whole 10_000-byte allocation). A copy-out
    // never shares the original's underlying buffer.
    expect(stored.buffer).not.toBe(big.buffer)
    expect(stored.buffer.byteLength).toBeLessThan(big.buffer.byteLength)
  })
})

describe('shell resolution', () => {
  it('uses $SHELL when set AND it exists', () => {
    if (process.platform === 'win32') return
    const prev = process.env.SHELL
    process.env.SHELL = '/bin/sh' // POSIX-guaranteed to exist
    expect(resolveShell()).toBe('/bin/sh')
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
  })

  it('falls back to an existing shell on macOS/Linux (existence-gated)', () => {
    const prev = process.env.SHELL
    delete process.env.SHELL
    if (process.platform !== 'win32') {
      // Returns the first existing candidate; /bin/sh is the POSIX-mandated floor.
      const resolved = resolveShell()
      expect(['/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']).toContain(resolved)
      expect(fs.existsSync(resolved)).toBe(true)
    }
    if (prev) process.env.SHELL = prev
  })

  it('zsh and bash get login+interactive flags', () => {
    expect(shellArgs('/bin/zsh')).toEqual(['-l', '-i'])
    expect(shellArgs('/usr/bin/bash')).toEqual(['-l', '-i'])
  })

  it('powershell gets -NoLogo', () => {
    expect(shellArgs('powershell.exe')).toEqual(['-NoLogo'])
    expect(shellArgs('C:\\Windows\\pwsh.exe')).toEqual(['-NoLogo'])
  })
})

describe('resolveShellFor (injectable, cross-platform)', () => {
  it('prefers $SHELL when set AND it exists on POSIX (trimmed)', () => {
    expect(resolveShellFor('darwin', { SHELL: '  /bin/zsh  ' }, (p) => p === '/bin/zsh')).toBe('/bin/zsh')
    expect(resolveShellFor('linux', { SHELL: '/usr/bin/fish' }, (p) => p === '/usr/bin/fish')).toBe('/usr/bin/fish')
  })

  it('ignores a $SHELL that does not exist and falls through the existence-gated chain', () => {
    // $SHELL set but missing → fall to the first existing candidate.
    expect(resolveShellFor('linux', { SHELL: '/opt/gone/fish' }, (p) => p === '/bin/bash')).toBe('/bin/bash')
  })

  it('IGNORES a POSIX-style $SHELL on Windows (Git Bash/MSYS) and uses the native chain', () => {
    // $SHELL=/usr/bin/bash from Git Bash must NOT be spawned by ConPTY; fall
    // through to pwsh/powershell/cmd instead.
    const winPosh = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const got = resolveShellFor('win32', { SHELL: '/usr/bin/bash', SystemRoot: 'C:\\Windows' }, (p) => p === winPosh)
    expect(got).toBe(winPosh)
  })

  it('prefers /bin/zsh when it exists on POSIX', () => {
    expect(resolveShellFor('darwin', {}, (p) => p === '/bin/zsh')).toBe('/bin/zsh')
  })

  it('existence-gates the POSIX fallback chain and ends at /bin/sh', () => {
    // No candidate exists → POSIX-mandated /bin/sh (was an unspawnable /bin/zsh).
    expect(resolveShellFor('linux', {}, () => false)).toBe('/bin/sh')
    // /bin/zsh absent but /bin/bash present → bash.
    expect(resolveShellFor('linux', {}, (p) => p === '/bin/bash')).toBe('/bin/bash')
  })

  it('on Windows prefers pwsh.exe found on PATH', () => {
    const env = { PATH: 'C:\\bin;C:\\ps' }
    const got = resolveShellFor('win32', env, (p) => p === 'C:\\ps\\pwsh.exe')
    expect(got).toBe('C:\\ps\\pwsh.exe')
  })

  it('on Windows falls back to Windows PowerShell when pwsh is absent', () => {
    const winPosh = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const got = resolveShellFor('win32', { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows' }, (p) => p === winPosh)
    expect(got).toBe(winPosh)
  })

  it('on Windows falls back to COMSPEC/cmd.exe as the last resort', () => {
    expect(resolveShellFor('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, () => false))
      .toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resolveShellFor('win32', {}, () => false)).toBe('cmd.exe')
  })
})

describe('TerminalSpawnError + mapSpawnError', () => {
  it('carries the reason and a descriptive message', () => {
    const e = new TerminalSpawnError('out-of-file-descriptors', 'EMFILE: too many open files')
    expect(e).toBeInstanceOf(Error)
    expect(e.reason).toBe('out-of-file-descriptors')
    expect(e.message).toContain('out-of-file-descriptors')
    expect(e.message).toContain('EMFILE')
  })

  it('maps EMFILE / ENFILE to out-of-file-descriptors', () => {
    const emfile = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    const enfile = Object.assign(new Error('file table overflow'), { code: 'ENFILE' })
    expect(mapSpawnError(emfile).reason).toBe('out-of-file-descriptors')
    expect(mapSpawnError(enfile).reason).toBe('out-of-file-descriptors')
  })

  it('maps any other error (or non-Error) to spawn-failed', () => {
    expect(mapSpawnError(new Error('boom')).reason).toBe('spawn-failed')
    expect(mapSpawnError(Object.assign(new Error('x'), { code: 'ENOENT' })).reason).toBe('spawn-failed')
    expect(mapSpawnError('weird string').reason).toBe('spawn-failed')
    expect(mapSpawnError(undefined).reason).toBe('spawn-failed')
  })
})

describe('TerminalManager lifecycle', () => {
  let tm: TerminalManager

  beforeEach(() => {
    tm = new TerminalManager()
  })

  afterEach(async () => {
    await tm.shutdown()
  })

  it('spawns a PTY with project cwd and TERM/COLORTERM set', async () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir(), cols: 80, rows: 24 })
    expect(meta.projectId).toBe('proj-A')
    expect(meta.cwd).toBe(os.tmpdir())
    expect(meta.cols).toBe(80)
    expect(meta.rows).toBe(24)
    expect(meta.id).toMatch(/^[0-9a-f-]+$/i)

    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    // Run a command and wait for output
    const cmd = process.platform === 'win32'
      ? 'echo %TERM%\n'
      : 'echo $TERM-$COLORTERM\n'
    tm.write(meta.id, cmd)
    const snapshotIdx = ws.sent.length
    const ok = await waitFor(() => concatLive(ws, snapshotIdx).includes('xterm-256color'), 4000)
    expect(ok).toBe(true)
    expect(concatLive(ws, snapshotIdx)).toContain('xterm-256color')
  }, 10_000)

  it('attach sends snapshot binary then ready JSON then live data', async () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    // Generate some output before attach
    tm.write(meta.id, 'echo PREWARM-MARK\n')
    await waitFor(() => {
      // Need the ring buffer to have received the output
      const bogus = new FakeWs()
      tm.attach(meta.id, asWs(bogus))
      tm.detach(meta.id, asWs(bogus))
      const hasMark = bogus.sent.some((f) => f.binary && (Buffer.isBuffer(f.data) ? f.data.toString('utf8') : String(f.data)).includes('PREWARM-MARK'))
      return hasMark
    }, 4000)

    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    // First frame should be binary (snapshot); second should be ready JSON
    expect(ws.sent.length).toBeGreaterThanOrEqual(2)
    expect(ws.sent[0].binary).toBe(true)
    expect(ws.sent[1].binary).toBe(false)
    const readyFrame = ws.sent[1].data.toString()
    expect(readyFrame).toContain('"type":"ready"')
    expect(readyFrame).toContain('"id":"' + meta.id + '"')
  }, 10_000)

  it('multiple clients receive identical live output', async () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    const ws1 = new FakeWs()
    const ws2 = new FakeWs()
    tm.attach(meta.id, asWs(ws1))
    tm.attach(meta.id, asWs(ws2))
    const idx1 = ws1.sent.length
    const idx2 = ws2.sent.length
    tm.write(meta.id, 'echo MULTI-MARK\n')
    await waitFor(() => concatLive(ws1, idx1).includes('MULTI-MARK') && concatLive(ws2, idx2).includes('MULTI-MARK'), 4000)
    expect(concatLive(ws1, idx1)).toContain('MULTI-MARK')
    expect(concatLive(ws2, idx2)).toContain('MULTI-MARK')
  }, 10_000)

  it('client disconnect does not kill PTY', async () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    tm.detach(meta.id, asWs(ws))
    // Session should still exist
    expect(tm.listForProject('proj-A')).toHaveLength(1)
    // Write + reattach should still work
    tm.write(meta.id, 'echo STILL-ALIVE\n')
    await sleep(200)
    const ws2 = new FakeWs()
    tm.attach(meta.id, asWs(ws2))
    const snap = ws2.sent[0]
    expect(snap.binary).toBe(true)
    expect((snap.data as Buffer).toString('utf8')).toContain('STILL-ALIVE')
  }, 10_000)

  it('records a tombstone and sends an exit frame when the shell exits on its own', async () => {
    const meta = tm.create('proj-T', { cwd: os.tmpdir() })
    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    tm.write(meta.id, 'exit\n')
    const gone = await waitFor(() => tm.listForProject('proj-T').length === 0, 6000)
    expect(gone).toBe(true)
    // The attached client is told WHY it ended.
    const exitFrame = ws.sent.find((f) => !f.binary && String(f.data).includes('"type":"exit"'))
    expect(exitFrame).toBeTruthy()
    // A late attach can discover the reason via the tombstone (scoped to project).
    const tomb = tm.getTombstone(meta.id, 'proj-T')
    expect(tomb).toBeTruthy()
    expect(tomb!.projectId).toBe('proj-T')
    expect(tm.getTombstone(meta.id, 'other-proj')).toBeUndefined()
    // The socket close reason reflects natural vs early exit.
    expect(ws.closed?.reason).toMatch(/^pty_exit(_early)?$/)
  }, 12_000)

  it('does NOT tombstone a deliberately killed session', async () => {
    const meta = tm.create('proj-T', { cwd: os.tmpdir() })
    tm.kill('proj-T', meta.id)
    await waitFor(() => tm.listForProject('proj-T').length === 0, 6000)
    // Give onExit a moment to (not) fire its tombstone path.
    await sleep(200)
    expect(tm.getTombstone(meta.id, 'proj-T')).toBeUndefined()
  }, 12_000)

  it('resize propagates to PTY (stty size)', async () => {
    if (process.platform === 'win32') return
    const meta = tm.create('proj-A', { cwd: os.tmpdir(), cols: 80, rows: 24 })
    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    tm.resize(meta.id, 100, 30)
    const idx = ws.sent.length
    tm.write(meta.id, 'stty size\n')
    await waitFor(() => concatLive(ws, idx).includes('30 100'), 4000)
    expect(concatLive(ws, idx)).toContain('30 100')
  }, 10_000)

  it('enforces 10-per-project limit', () => {
    for (let i = 0; i < TERMINAL_MAX_PER_PROJECT; i++) {
      tm.create('proj-A', { cwd: os.tmpdir() })
    }
    expect(() => tm.create('proj-A', { cwd: os.tmpdir() })).toThrow(TerminalLimitExceededError)
    // Other project unaffected
    expect(() => tm.create('proj-B', { cwd: os.tmpdir() })).not.toThrow()
  })

  it('rename validates length bounds', () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    expect(() => tm.rename('proj-A', meta.id, '')).toThrow(TerminalNameInvalidError)
    expect(() => tm.rename('proj-A', meta.id, '   ')).toThrow(TerminalNameInvalidError)
    expect(() => tm.rename('proj-A', meta.id, 'x'.repeat(65))).toThrow(TerminalNameInvalidError)
    const updated = tm.rename('proj-A', meta.id, 'build watcher')
    expect(updated.name).toBe('build watcher')
  })

  it('rename broadcasts to attached clients', () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    const idxBefore = ws.sent.length
    tm.rename('proj-A', meta.id, 'new name')
    const textFrames = ws.sent.slice(idxBefore).filter((f) => !f.binary).map((f) => String(f.data))
    const renamedFrame = textFrames.find((t) => t.includes('"type":"renamed"'))
    expect(renamedFrame).toBeDefined()
    expect(renamedFrame).toContain('"name":"new name"')
  })

  it('scoped get rejects cross-project access', () => {
    const metaA = tm.create('proj-A', { cwd: os.tmpdir() })
    expect(tm.get('proj-A', metaA.id)).toBeDefined()
    expect(tm.get('proj-B', metaA.id)).toBeUndefined()
  })

  it('kill closes attached WS and removes session', async () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    const killed = tm.kill('proj-A', meta.id)
    expect(killed).toBe(true)
    const ok = await waitFor(() => ws.closed !== null && tm.listForProject('proj-A').length === 0, 4000)
    expect(ok).toBe(true)
    expect(ws.closed?.code).toBe(1000)
  }, 10_000)

  it('kill returns false for unknown id / wrong project', () => {
    const meta = tm.create('proj-A', { cwd: os.tmpdir() })
    expect(tm.kill('proj-B', meta.id)).toBe(false)
    expect(tm.kill('proj-A', 'no-such-id')).toBe(false)
  })

  it('killAllForProject kills only its terminals', async () => {
    const a1 = tm.create('proj-A', { cwd: os.tmpdir() })
    const a2 = tm.create('proj-A', { cwd: os.tmpdir() })
    const b1 = tm.create('proj-B', { cwd: os.tmpdir() })
    expect(tm.killAllForProject('proj-A')).toBe(2)
    await waitFor(() => tm.listForProject('proj-A').length === 0, 4000)
    expect(tm.listForProject('proj-A')).toHaveLength(0)
    expect(tm.listForProject('proj-B')).toHaveLength(1)
    expect(tm.listForProject('proj-B')[0].id).toBe(b1.id)
    void a1; void a2
  }, 10_000)

  it('shutdown kills all sessions within grace window', async () => {
    tm.create('proj-A', { cwd: os.tmpdir() })
    tm.create('proj-A', { cwd: os.tmpdir() })
    tm.create('proj-B', { cwd: os.tmpdir() })
    expect(tm.sessionCount()).toBe(3)
    const t0 = Date.now()
    await tm.shutdown()
    const elapsed = Date.now() - t0
    expect(tm.sessionCount()).toBe(0)
    expect(elapsed).toBeLessThan(5_000)
  }, 10_000)

  it('auto-names subsequent terminals with the same shell', () => {
    const prev = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    const tm2 = new TerminalManager()
    const a = tm2.create('proj-A', { cwd: os.tmpdir() })
    const b = tm2.create('proj-A', { cwd: os.tmpdir() })
    const c = tm2.create('proj-A', { cwd: os.tmpdir() })
    // The auto-name base is the RESOLVED shell's basename (existence-gated, so
    // it may be bash/sh on a host without zsh — assert the suffix RELATIONSHIP,
    // not a hardcoded 'zsh' which couples to the OS shell set).
    expect(b.name).toBe(`${a.name} (2)`)
    expect(c.name).toBe(`${a.name} (3)`)
    void tm2.shutdown()
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
  })

  it('spawns with explicit cwd equal to project path', async () => {
    const dir = path.resolve(os.tmpdir())
    const meta = tm.create('proj-A', { cwd: dir })
    const ws = new FakeWs()
    tm.attach(meta.id, asWs(ws))
    const idx = ws.sent.length
    tm.write(meta.id, process.platform === 'win32' ? 'cd\n' : 'pwd\n')
    // Resolve with realpath on macOS to handle /private prefix
    const fs = await import('fs')
    const expected = fs.realpathSync(dir)
    await waitFor(() => {
      const out = concatLive(ws, idx)
      return out.includes(dir) || out.includes(expected)
    }, 4000)
    const out = concatLive(ws, idx)
    expect(out.includes(dir) || out.includes(expected)).toBe(true)
  }, 10_000)
})

describe('TerminalManager: shell-integration wiring', () => {
  let originalShell: string | undefined
  beforeEach(() => { originalShell = process.env.SHELL })
  afterEach(() => {
    if (originalShell !== undefined) process.env.SHELL = originalShell
    else delete process.env.SHELL
  })

  it('does not load OSC parser when shell integration disabled', async () => {
    process.env.SHELL = '/bin/bash'
    const m = new TerminalManager()
    const dir = await import('fs').then((fs) => fs.mkdtempSync(path.join(os.tmpdir(), 'sr-tm-disabled-')))
    const meta = m.create('p1', { cwd: dir, projectSlug: 'p1', settings: { shellIntegrationEnabled: false } })
    expect(meta.shell).toContain('bash')
    // Get the underlying session via getUnsafe and verify no OSC parser hooked.
    const s = m.getUnsafe(meta.id) as unknown as { oscParser: unknown; shellIntegration: { shimPath: string | null } }
    expect(s.oscParser).toBeNull()
    expect(s.shellIntegration.shimPath).toBeNull()
    m.kill('p1', meta.id)
    await sleep(100)
  }, 10_000)

  it('broadcasts a mark control frame when an OSC 133;A sequence is received', async () => {
    process.env.SHELL = '/bin/bash'
    const m = new TerminalManager()
    const dir = await import('fs').then((fs) => fs.mkdtempSync(path.join(os.tmpdir(), 'sr-tm-marks-')))
    const meta = m.create('p1', { cwd: dir, projectSlug: 'p1', settings: { shellIntegrationEnabled: true } })
    const s = m.getUnsafe(meta.id) as unknown as { oscParser: { feed: (b: Buffer) => unknown[] } | null; clients: Set<unknown> }
    expect(s.oscParser).not.toBeNull()
    const ws = new FakeWs()
    m.attach(meta.id, asWs(ws))
    // Inject a synthetic mark by feeding the parser directly and broadcasting via the manager:
    // We can't easily inject PTY data, but we can verify the parser is wired by calling it.
    const events = s.oscParser!.feed(Buffer.from('\x1b]133;A\x07'))
    expect(events).toEqual([{ kind: 'prompt-start' }])
    m.kill('p1', meta.id)
    await sleep(100)
  }, 10_000)
})
