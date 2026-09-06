import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

vi.mock('./win-spawn', async (original) => ({
  ...await original<typeof import('./win-spawn')>(),
  spawnCli: vi.fn(),
}))
import { spawnCli } from './win-spawn'
import { spawnClaude, spawnGemini, transformCodexArgsForWindows } from './cli-prompt'
import { InteractiveJobSession } from '../interactive-job-session'
import { initDb, createJob } from '../db'
import { getAdapter } from '../providers'

afterEach(() => { vi.restoreAllMocks() })
function fakeChild() {
  const writes: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done() } }),
    stdout: new Readable({ read() {} }), stderr: new Readable({ read() {} }),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess
  vi.mocked(spawnCli).mockReturnValue(child)
  return { child, writes }
}

describe('Windows provider prompt transports', () => {
  it('keeps Claude resident stdin open through the real auto-settle session and first JSON turn', () => {
    const db = initDb(':memory:')
    createJob(db, { id: 'win-loop', command: '/specrails:implement #1', started_at: new Date().toISOString(), interactive: true })
    const { child, writes } = fakeChild()
    const adapter = getAdapter('claude')
    const args = adapter.buildArgs('chat-stream', { prompt: '', model: 'sonnet', toolPolicy: 'none', systemPrompt: 'Reglas\nEspaña' })
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const session = new InteractiveJobSession({ db, jobId: 'win-loop', projectId: 'p', adapter,
        broadcast: vi.fn(), onSettle: vi.fn(), settleMode: 'auto' })
      session.start({ binary: 'claude', args }, '/specrails:implement #1\nconservar UTF-8 ñ')
      expect(child.stdin!.writableEnded).toBe(false)
      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0])).toMatchObject({ type: 'user', message: { role: 'user' } })
      expect(writes[0]).toContain('conservar UTF-8 ñ')
      const forwarded = vi.mocked(spawnCli).mock.calls.at(-1)![1]!
      const systemFile = forwarded[forwarded.indexOf('--system-prompt-file') + 1]
      const appendedFile = forwarded[forwarded.indexOf('--append-system-prompt-file') + 1]
      expect(readFileSync(systemFile, 'utf8')).toBe('Reglas\nEspaña')
      expect(readFileSync(appendedFile, 'utf8')).toContain('background')
      expect(forwarded).toContain('--input-format')
      child.emit('close', 1)
      expect(existsSync(systemFile)).toBe(false)
      expect(existsSync(appendedFile)).toBe(false)
    } finally { platform.mockRestore(); db.close() }
  })

  it('cleans Claude private prompt files when spawning fails synchronously', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let file = ''
    vi.mocked(spawnCli).mockImplementationOnce((_binary, args) => {
      file = args![args!.indexOf('--append-system-prompt-file') + 1]
      expect(readFileSync(file, 'utf8')).toBe('bounded\nsystem')
      throw new Error('fixture ENOENT')
    })
    try {
      expect(() => spawnClaude(['-p', '--input-format', 'stream-json', '--append-system-prompt', 'bounded\nsystem'])).toThrow('fixture ENOENT')
      expect(existsSync(file)).toBe(false)
    } finally { platform.mockRestore() }
  })

  it('transmits Gemini multiline/long prompts as stdin and retains resume, model, output and environment', () => {
    const { child, writes } = fakeChild()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const prompt = 'España & "quoted"\r\n'.repeat(1000)
      spawnGemini(['-p', prompt, '--model', 'gemini-3', '--resume', 'session', '--output-format', 'stream-json'], { cwd: 'C:\\repos\\My app', env: { GEMINI_API_KEY: 'fixture' } })
      expect(writes.join('')).toBe(prompt)
      expect(child.stdin!.writableEnded).toBe(true)
      expect(spawnCli).toHaveBeenLastCalledWith('gemini', ['--model', 'gemini-3', '--resume', 'session', '--output-format', 'stream-json'], expect.objectContaining({
        cwd: 'C:\\repos\\My app', stdio: ['pipe', 'pipe', 'pipe'], env: expect.objectContaining({ GEMINI_API_KEY: 'fixture', GEMINI_CLI_TRUST_WORKSPACE: 'true' }),
      }))
      expect(() => child.stdin!.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }))).not.toThrow()
    } finally { platform.mockRestore() }
  })

  it('moves long single-line Codex prompts off the Windows command line', () => {
    const prompt = 'a'.repeat(9000)
    expect(transformCodexArgsForWindows(['exec', '--model', 'gpt-6-astra', prompt, '--json'])).toEqual({
      args: ['exec', '--model', 'gpt-6-astra', '-', '--json'], stdinPayload: prompt,
    })
    expect(transformCodexArgsForWindows(['exec', 'small'])).toEqual({ args: ['exec', 'small'], stdinPayload: null })
  })
})
