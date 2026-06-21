import { describe, it, expect } from 'vitest'
import os from 'os'
import { redact, stripHome, scrubAbsolutePaths } from './mobile-redact'

describe('mobile-redact', () => {
  it('strips the home dir from strings', () => {
    const home = os.homedir()
    expect(stripHome(`${home}/repos/x`)).toBe('~/repos/x')
    expect(stripHome('no home here')).toBe('no home here')
  })

  it('drops sensitive keys at any depth', () => {
    const input = {
      id: 'p1',
      path: '/Users/x/secret',
      db_path: '/Users/x/db.sqlite',
      nested: { absolutePath: '/a/b', keep: 'yes', cwd: '/c' },
      list: [{ projectPath: '/p', name: 'ok' }],
    }
    const out = redact(input) as Record<string, unknown>
    expect(out.path).toBeUndefined()
    expect(out.db_path).toBeUndefined()
    expect((out.nested as Record<string, unknown>).absolutePath).toBeUndefined()
    expect((out.nested as Record<string, unknown>).cwd).toBeUndefined()
    expect((out.nested as Record<string, unknown>).keep).toBe('yes')
    expect((out.list as Array<Record<string, unknown>>)[0].projectPath).toBeUndefined()
    expect((out.list as Array<Record<string, unknown>>)[0].name).toBe('ok')
  })

  it('scrubs the home dir inside surviving strings (e.g. job command)', () => {
    const home = os.homedir()
    const out = redact({ command: `cd ${home}/p && run` }) as { command: string }
    expect(out.command).toBe('cd ~/p && run')
  })

  it('passes primitives through unchanged and never mutates input', () => {
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
    expect(redact(null)).toBe(null)
    const input = { a: 1 }
    redact(input)
    expect(input).toEqual({ a: 1 })
  })

  // ── BUG-MOBILE-06: scrub absolute paths outside $HOME and under un-keyed fields ──
  describe('absolute-path scrubbing (BUG-MOBILE-06)', () => {
    it('scrubs POSIX absolute paths NOT under $HOME', () => {
      expect(scrubAbsolutePaths('/Volumes/Work/repo')).toBe('[path]')
      expect(scrubAbsolutePaths('error at /tmp/x/file.ts:10')).toBe('error at [path]')
      expect(scrubAbsolutePaths('/srv/app/main and /opt/lib/x')).toBe('[path] and [path]')
    })

    it('scrubs Windows drive and UNC paths', () => {
      expect(scrubAbsolutePaths('C:\\Users\\bob\\repo')).toBe('[path]')
      expect(scrubAbsolutePaths('D:/code/project')).toBe('[path]')
      expect(scrubAbsolutePaths('\\\\server\\share\\x')).toBe('[path]')
    })

    it('preserves URLs, slash-commands, and bare slashes', () => {
      expect(scrubAbsolutePaths('see https://specrails.dev/companion-signal.php')).toBe(
        'see https://specrails.dev/companion-signal.php',
      )
      // The gateway forwards `/specrails:implement #34` verbatim — single segment.
      expect(scrubAbsolutePaths('/specrails:implement #34')).toBe('/specrails:implement #34')
      expect(scrubAbsolutePaths('a / b')).toBe('a / b')
      expect(scrubAbsolutePaths('plain text')).toBe('plain text')
    })

    it('redact() scrubs an absolute path outside $HOME carried by an un-keyed field', () => {
      // Job command / error message fields are NOT in SENSITIVE_KEYS, so before
      // this fix a non-$HOME path leaked verbatim to the phone.
      const out = redact({
        command: 'run /Volumes/Work/secret/repo',
        error: { message: 'ENOENT: /etc/passwd/shadow not found' },
        list: ['/mnt/data/db.sqlite'],
      }) as { command: string; error: { message: string }; list: string[] }
      expect(out.command).toBe('run [path]')
      expect(out.error.message).toBe('ENOENT: [path] not found')
      expect(out.list[0]).toBe('[path]')
    })

    it('still collapses $HOME to ~ before scrubbing (no double-redaction of home paths)', () => {
      const home = os.homedir()
      const out = redact({ command: `cd ${home}/repos/x && run` }) as { command: string }
      expect(out.command).toBe('cd ~/repos/x && run')
    })
  })
})
