import { describe, it, expect, vi } from 'vitest'

// Wrap spawnCli with a spy that still delegates to the real implementation, so
// the real-binary dispatch tests keep working while the env-passthrough tests
// can inspect the options handed to spawnCli.
vi.mock('./win-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./win-spawn')>()
  return { ...actual, spawnCli: vi.fn(actual.spawnCli) }
})

import {
  transformClaudeArgsForWindows,
  transformCodexArgsForWindows,
  ensureStdinPipe,
  spawnClaude,
  spawnCodex,
  spawnGemini,
  spawnAiCli,
} from './cli-prompt'
import { spawnCli } from './win-spawn'

describe('transformClaudeArgsForWindows', () => {
  it('returns args unchanged when no prompt flags are present', () => {
    const args = ['--dangerously-skip-permissions', '--verbose']
    const out = transformClaudeArgsForWindows(args)
    expect(out.args).toEqual(args)
    expect(out.stdinPayload).toBeNull()
  })

  it('extracts -p value into stdin and re-adds bare -p', () => {
    const out = transformClaudeArgsForWindows([
      '--verbose',
      '-p',
      'hello\nworld',
    ])
    expect(out.args).toEqual(['--verbose', '-p'])
    expect(out.stdinPayload).toBe('hello\nworld')
  })

  it('joins --system-prompt + -p with separator preserving order', () => {
    const out = transformClaudeArgsForWindows([
      '--system-prompt',
      'system rules',
      '--verbose',
      '-p',
      'user idea',
    ])
    expect(out.args).toEqual(['--verbose', '-p'])
    expect(out.stdinPayload).toBe('system rules\n\n---\n\nuser idea')
  })

  it('handles --append-system-prompt + -p combination', () => {
    const out = transformClaudeArgsForWindows([
      '--append-system-prompt',
      'append rules',
      '-p',
      '/specrails:implement #3 --yes',
    ])
    expect(out.args).toEqual(['-p'])
    expect(out.stdinPayload).toBe('append rules\n\n---\n\n/specrails:implement #3 --yes')
  })

  it('treats --print as an alias for -p', () => {
    const out = transformClaudeArgsForWindows([
      '--print',
      'value with\nnewline',
      '--model',
      'claude-x',
    ])
    expect(out.args).toEqual(['--model', 'claude-x', '-p'])
    expect(out.stdinPayload).toBe('value with\nnewline')
  })

  it('preserves non-prompt flags around extracted prompt flags', () => {
    const out = transformClaudeArgsForWindows([
      '--dangerously-skip-permissions',
      '--max-turns',
      '4',
      '--system-prompt',
      'sys',
      '--model',
      'm',
      '-p',
      'usr',
    ])
    expect(out.args).toEqual([
      '--dangerously-skip-permissions',
      '--max-turns',
      '4',
      '--model',
      'm',
      '-p',
    ])
    expect(out.stdinPayload).toBe('sys\n\n---\n\nusr')
  })

  it('keeps trailing prompt flag without value untouched', () => {
    // -p with no following value is a flag without arg; should be preserved
    // and no stdin payload created. (Edge case: tail position.)
    const out = transformClaudeArgsForWindows(['--verbose', '-p'])
    expect(out.args).toEqual(['--verbose', '-p'])
    expect(out.stdinPayload).toBeNull()
  })

  it('does NOT consume the next flag as a value for a valueless -p (chat-stream)', () => {
    // BUG-SPAWN-01: persistent-stdin / interactive-freestyle emit a bare `-p`
    // immediately followed by `--input-format stream-json` (the prompt arrives
    // over stdin). The transform must NOT collect `--input-format` as a prompt,
    // must leave the valueless `-p` in place, and must produce no stdin payload.
    const out = transformClaudeArgsForWindows([
      '--verbose',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ])
    expect(out.args).toEqual([
      '--verbose',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ])
    expect(out.stdinPayload).toBeNull()
  })

  it('still routes a -p <multiline value> into stdin (value is not a flag)', () => {
    const out = transformClaudeArgsForWindows([
      '--verbose',
      '-p',
      'line one\nline two\nline three',
    ])
    expect(out.args).toEqual(['--verbose', '-p'])
    expect(out.stdinPayload).toBe('line one\nline two\nline three')
  })

  it('does not duplicate -p when a system-prompt value coexists with a bare -p', () => {
    // --system-prompt carries a real value; the bare `-p` is the chat-stream
    // stdin marker. Only one `-p` may remain in the rewritten argv.
    const out = transformClaudeArgsForWindows([
      '--system-prompt',
      'system rules',
      '-p',
      '--input-format',
      'stream-json',
    ])
    expect(out.args).toEqual(['-p', '--input-format', 'stream-json'])
    expect(out.args.filter((t) => t === '-p')).toHaveLength(1)
    expect(out.stdinPayload).toBe('system rules')
  })
})

describe('spawnClaude (Windows arg-rewrite path)', () => {
  // Force the Windows branch by stubbing process.platform — `isWin` is now a
  // per-call check, so NO module re-import is needed. We stub the (already
  // top-level-mocked) spawnCli for one call with mockImplementationOnce so it
  // returns a fake child instead of spawning a real `claude` (which would ENOENT
  // on CI). This removes the old flaky vi.doMock + resetModules + dynamic-import
  // dance that intermittently leaked a real spawn → unhandled ENOENT.
  const fakeChild = (endSpy: () => void) =>
    ({ stdin: { end: endSpy } }) as unknown as ReturnType<typeof spawnCli>

  it('passes a bare -p chat-stream argv through untouched and does NOT end() stdin', () => {
    const endSpy = vi.fn()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.mocked(spawnCli).mockImplementationOnce(() => fakeChild(endSpy))
    try {
      const args = ['--verbose', '-p', '--input-format', 'stream-json']
      spawnClaude(args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const call = vi.mocked(spawnCli).mock.calls.at(-1)!
      expect(call[0]).toBe('claude')
      expect(call[1]).toEqual(args) // argv untouched — no consumed flag, no extra -p
      expect(endSpy).not.toHaveBeenCalled() // no bogus stdin payload written
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('routes a -p <multiline value> through stdin on Windows', () => {
    const endSpy = vi.fn()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.mocked(spawnCli).mockImplementationOnce(() => fakeChild(endSpy))
    try {
      spawnClaude(['--verbose', '-p', 'multi\nline\nprompt'], { stdio: ['pipe', 'pipe', 'pipe'] })
      const call = vi.mocked(spawnCli).mock.calls.at(-1)!
      expect(call[1]).toEqual(['--verbose', '-p'])
      expect(endSpy).toHaveBeenCalledWith('multi\nline\nprompt')
    } finally {
      platformSpy.mockRestore()
    }
  })
})

describe('transformCodexArgsForWindows', () => {
  it('returns args unchanged when first token is not exec', () => {
    const args = ['--help']
    const out = transformCodexArgsForWindows(args)
    expect(out.args).toEqual(args)
    expect(out.stdinPayload).toBeNull()
  })

  it('keeps single-line exec prompt as positional argv', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      'short prompt',
      '--model',
      'gpt-x',
    ])
    expect(out.args).toEqual(['exec', 'short prompt', '--model', 'gpt-x'])
    expect(out.stdinPayload).toBeNull()
  })

  it('routes multi-line exec prompt through stdin with `-` placeholder', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      'multi\nline\nprompt',
      '--model',
      'gpt-x',
    ])
    expect(out.args).toEqual(['exec', '-', '--model', 'gpt-x'])
    expect(out.stdinPayload).toBe('multi\nline\nprompt')
  })

  it('handles boolean flags like --full-auto before the prompt', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      '--full-auto',
      'system\nuser combined',
    ])
    expect(out.args).toEqual(['exec', '--full-auto', '-'])
    expect(out.stdinPayload).toBe('system\nuser combined')
  })

  it('treats --sandbox as a value-bearing flag before the prompt', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'system\nuser combined',
      '--model',
      'gpt-x',
    ])
    expect(out.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-',
      '--model',
      'gpt-x',
    ])
    expect(out.stdinPayload).toBe('system\nuser combined')
  })

  it('treats --model as a value-bearing flag (does not consume as prompt)', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      '--model',
      'gpt-y',
      'multi\nline',
    ])
    expect(out.args).toEqual(['exec', '--model', 'gpt-y', '-'])
    expect(out.stdinPayload).toBe('multi\nline')
  })

  it('keeps subsequent positionals after the first as argv', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      'multi\nline',
      'extra-positional',
    ])
    expect(out.args).toEqual(['exec', '-', 'extra-positional'])
    expect(out.stdinPayload).toBe('multi\nline')
  })

  it('routes multiline exec resume prompt through stdin after session id', () => {
    const out = transformCodexArgsForWindows([
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      '--skip-git-repo-check',
      'thread-123',
      'next\nturn',
      '--model',
      'gpt-x',
    ])
    expect(out.args).toEqual([
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      '--skip-git-repo-check',
      'thread-123',
      '-',
      '--model',
      'gpt-x',
    ])
    expect(out.stdinPayload).toBe('next\nturn')
  })
})

describe('spawn dispatch (POSIX fallthrough)', () => {
  // Tests call spawnClaude / spawnCodex / spawnAiCli on POSIX where the
  // helpers short-circuit to plain spawnCli. This drives coverage of the
  // !isWin branch and the spawnAiCli dispatcher for free.
  // On Windows runners these tests are skipped because the binaries we
  // invoke ('echo', 'true') don't exist as .cmd shims.
  const skipOnWin = process.platform === 'win32'

  // Each spawn function is invoked synchronously then the child is killed
  // on the next tick. We don't await close — the goal is exercising the
  // POSIX !isWin branch + dispatcher logic for coverage. Awaiting risks
  // hanging on long-lived binaries (codex on a dev machine, claude session).
  function smokeSpawnSync(child: ReturnType<typeof spawnClaude>): void {
    expect(child).toBeDefined()
    child.on('error', () => { /* swallow ENOENT — binary may be absent */ })
    setImmediate(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } })
  }

  it('spawnClaude on POSIX returns a ChildProcess via spawnCli', () => {
    if (skipOnWin) return
    smokeSpawnSync(spawnClaude(['--help'], { stdio: ['ignore', 'pipe', 'pipe'] }))
  })

  it('spawnCodex on POSIX returns a ChildProcess via spawnCli', () => {
    if (skipOnWin) return
    smokeSpawnSync(spawnCodex(['exec', 'noop'], { stdio: ['ignore', 'pipe', 'pipe'] }))
  })

  it('spawnGemini injects GEMINI_CLI_TRUST_WORKSPACE and spawns via spawnCli', () => {
    if (skipOnWin) return
    // Merge into a caller-provided env (not just process.env) and assert the
    // trust var is set — without it gemini silently disables --yolo headless.
    const child = spawnGemini(['--version'], { env: { FOO: 'bar' }, stdio: ['ignore', 'pipe', 'pipe'] })
    smokeSpawnSync(child)
  })

  it('spawnGemini forwards GEMINI_API_KEY from process.env into the spawn env', () => {
    if (skipOnWin) return
    // Without the key in the env, gemini-cli falls back to OAuth → macOS Keychain
    // re-prompts. Forwarding it from process.env keeps gemini on API-key auth.
    const prev = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'sk-test-123'
    try {
      const child = spawnGemini(['--version'], { env: { FOO: 'bar' }, stdio: ['ignore', 'pipe', 'pipe'] })
      smokeSpawnSync(child)
      const opts = vi.mocked(spawnCli).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }
      expect(opts.env.GEMINI_API_KEY).toBe('sk-test-123')
      expect(opts.env.FOO).toBe('bar') // caller env preserved
      expect(opts.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY
      else process.env.GEMINI_API_KEY = prev
    }
  })

  it('spawnGemini does NOT override a key already present in options.env', () => {
    if (skipOnWin) return
    const prev = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'from-process'
    try {
      const child = spawnGemini(['--version'], {
        env: { GEMINI_API_KEY: 'from-caller' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      smokeSpawnSync(child)
      const opts = vi.mocked(spawnCli).mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }
      expect(opts.env.GEMINI_API_KEY).toBe('from-caller')
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY
      else process.env.GEMINI_API_KEY = prev
    }
  })

  it('spawnAiCli runs a real binary end-to-end on POSIX', async () => {
    if (skipOnWin) return
    const child = spawnAiCli('echo', ['hello'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', (b: Buffer) => { out += b.toString() })
    const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? -1)))
    expect(code).toBe(0)
    expect(out.trim()).toBe('hello')
  })

  it('spawnAiCli dispatches "claude"/"codex"/"gemini"/other through the right wrapper', () => {
    if (skipOnWin) return
    for (const bin of ['claude', 'codex', 'gemini', 'true']) {
      smokeSpawnSync(spawnAiCli(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] }))
    }
  })
})

describe('ensureStdinPipe', () => {
  it('returns full pipe stdio when undefined', () => {
    expect(ensureStdinPipe(undefined)).toEqual(['pipe', 'pipe', 'pipe'])
  })

  it('keeps a string stdio mapped uniformly except stdin pipe', () => {
    expect(ensureStdinPipe('inherit')).toEqual(['pipe', 'inherit', 'inherit'])
  })

  it('upgrades stdin from ignore to pipe and preserves stdout/stderr', () => {
    expect(ensureStdinPipe(['ignore', 'pipe', 'pipe'])).toEqual(['pipe', 'pipe', 'pipe'])
  })

  it('keeps explicit stdin entry as-is when not ignore', () => {
    expect(ensureStdinPipe(['pipe', 'inherit', 'inherit'])).toEqual(['pipe', 'inherit', 'inherit'])
  })

  it('falls back to defaults for missing array slots', () => {
    expect(ensureStdinPipe([] as never)).toEqual(['pipe', 'pipe', 'pipe'])
  })
})
