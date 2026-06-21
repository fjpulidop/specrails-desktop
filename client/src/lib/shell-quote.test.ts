import { describe, it, expect } from 'vitest'
import { quotePosix, quoteWindowsCmd, quoteWindowsPowerShell, quoteForHost, quotePathList } from './shell-quote'

describe('quotePosix', () => {
  it('quotes a plain path', () => {
    expect(quotePosix('/Users/me/file.txt')).toBe(`'/Users/me/file.txt'`)
  })
  it('quotes a path with spaces', () => {
    expect(quotePosix('/Users/me/My File.txt')).toBe(`'/Users/me/My File.txt'`)
  })
  it('escapes embedded single quotes', () => {
    expect(quotePosix(`/Users/me/it's.txt`)).toBe(`'/Users/me/it'\\''s.txt'`)
  })
  it('quotes paths with $, backticks, parens, &, |', () => {
    expect(quotePosix('/path/with $vars && (more) `cmd`'))
      .toBe(`'/path/with $vars && (more) \`cmd\`'`)
  })
})

describe('quoteWindowsCmd', () => {
  it('double-quotes a plain path', () => {
    expect(quoteWindowsCmd('C:\\Users\\me\\file.txt')).toBe(`"C:\\Users\\me\\file.txt"`)
  })
  it('escapes inner double quotes by doubling', () => {
    expect(quoteWindowsCmd('C:\\foo\\"bar".txt')).toBe(`"C:\\foo\\""bar"".txt"`)
  })
  it('escapes percent and caret', () => {
    expect(quoteWindowsCmd('foo%PATH%bar')).toBe(`"foo^%PATH^%bar"`)
    expect(quoteWindowsCmd('hello^world')).toBe(`"hello^^world"`)
  })
  it('handles paths with spaces and parens', () => {
    expect(quoteWindowsCmd('C:\\Program Files (x86)\\foo'))
      .toBe(`"C:\\Program Files (x86)\\foo"`)
  })
})

describe('quoteWindowsPowerShell (M3)', () => {
  it('single-quotes a plain path', () => {
    expect(quoteWindowsPowerShell('C:\\Users\\me\\file.txt')).toBe(`'C:\\Users\\me\\file.txt'`)
  })
  it('doubles inner single quotes', () => {
    expect(quoteWindowsPowerShell("C:\\it's.txt")).toBe(`'C:\\it''s.txt'`)
  })
  it('renders $(...) and backticks inert (no interpolation inside single quotes)', () => {
    // The whole payload survives as a literal single-quoted token — PowerShell
    // does not interpolate inside single quotes, so $(calc.exe) never executes.
    expect(quoteWindowsPowerShell('$(calc.exe).txt')).toBe(`'$(calc.exe).txt'`)
    expect(quoteWindowsPowerShell('`whoami`.txt')).toBe('\'`whoami`.txt\'')
  })
})

describe('quoteForHost / quotePathList', () => {
  it('routes to POSIX or PowerShell (Windows default shell) by flag', () => {
    expect(quoteForHost('/a b', false)).toBe(`'/a b'`)
    // Windows now uses PowerShell-safe single-quote quoting (M3), not cmd doubles.
    expect(quoteForHost('C:\\a b', true)).toBe(`'C:\\a b'`)
  })
  it('Windows quoting neutralizes a PowerShell injection payload', () => {
    expect(quoteForHost('$(calc.exe).txt', true)).toBe(`'$(calc.exe).txt'`)
  })
  it('joins multiple paths with single space', () => {
    expect(quotePathList(['/a b', '/c'], false)).toBe(`'/a b' '/c'`)
    expect(quotePathList(['C:\\a b', 'C:\\c'], true)).toBe(`'C:\\a b' 'C:\\c'`)
  })

  describe('Windows shell hint (BUG-CLIENT-02)', () => {
    it('defaults to PowerShell quoting on Windows (byte-identical to no-hint)', () => {
      // No hint and explicit 'powershell' must produce the same result.
      expect(quoteForHost('C:\\a b', true)).toBe(quoteForHost('C:\\a b', true, 'powershell'))
      expect(quoteForHost('C:\\a b', true, 'powershell')).toBe(`'C:\\a b'`)
    })

    it("cmd hint routes Windows quoting to quoteWindowsCmd (literal double quotes)", () => {
      expect(quoteForHost('C:\\Program Files (x86)\\foo', true, 'cmd'))
        .toBe(`"C:\\Program Files (x86)\\foo"`)
      // cmd metacharacters get caret/double escaping, not single-quote wrapping.
      expect(quoteForHost('foo%PATH%bar', true, 'cmd')).toBe(`"foo^%PATH^%bar"`)
    })

    it('hint is ignored on non-Windows (always POSIX)', () => {
      expect(quoteForHost('/a b', false, 'cmd')).toBe(`'/a b'`)
      expect(quoteForHost('/a b', false, 'powershell')).toBe(`'/a b'`)
    })

    it('quotePathList threads the cmd hint to each path', () => {
      expect(quotePathList(['C:\\a b', 'C:\\c'], true, 'cmd')).toBe(`"C:\\a b" "C:\\c"`)
      // default + explicit powershell stay single-quoted
      expect(quotePathList(['C:\\a b'], true)).toBe(`'C:\\a b'`)
      expect(quotePathList(['C:\\a b'], true, 'powershell')).toBe(`'C:\\a b'`)
    })
  })
})
