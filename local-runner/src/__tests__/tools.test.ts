import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { builtinTools, confinementRoots, globToRegExp, shellCommand, BASH_OUTPUT_CAP, type ToolContext } from '../tools'
import { SessionStore, SESSION_LRU_CAP, sessionsDir } from '../sessions'
import { detectSlashCommand, expandCommand, commandFilePath } from '../commands'
import { FrameEmitter } from '../frames'
import type { RunnableTool } from '../types'

let cwd: string
let ctx: ToolContext
let tools: Map<string, RunnableTool>

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-tools-'))
  fs.mkdirSync(path.join(cwd, 'src', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(cwd, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'const a = 1\nexport const needle = a\n')
  fs.writeFileSync(path.join(cwd, 'src', 'deep', 'b.ts'), 'needle again\n')
  fs.writeFileSync(path.join(cwd, 'README.md'), '# hi\nneedle in docs\n')
  fs.writeFileSync(path.join(cwd, 'node_modules', 'pkg', 'index.js'), 'needle hidden\n')
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]))
  ctx = { cwd, roots: confinementRoots(cwd, []), env: { PATH: process.env.PATH }, bashTimeoutMs: 2000 }
  tools = new Map(builtinTools(ctx, { kind: 'default' }).map((t) => [t.definition.function.name, t]))
})

afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }))

const call = (name: string, input: Record<string, unknown>) => (tools.get(name) as RunnableTool).run(input)

describe('Read', () => {
  it('numbers lines and honours offset/limit', async () => {
    const out = await call('Read', { file_path: 'src/a.ts', offset: 2, limit: 1 })
    expect(out.isError).toBe(false)
    expect(out.content).toBe('     2\texport const needle = a')
  })
  it('accepts the legacy `path` key and errors on missing files / bad types', async () => {
    expect((await call('Read', { path: 'README.md' })).content).toContain('# hi')
    expect(await call('Read', { file_path: 'nope.txt' })).toMatchObject({ isError: true })
    expect((await call('Read', { file_path: 42 })).content).toContain('non-empty string')
    expect((await call('Read', { file_path: 'README.md', offset: 'x' })).content).toContain('must be a number')
  })
  it('truncates huge output', async () => {
    fs.writeFileSync(path.join(cwd, 'big.txt'), 'x'.repeat(300 * 1024))
    const out = await call('Read', { file_path: 'big.txt' })
    expect(out.content).toContain('[truncated')
  })
})

describe('Grep', () => {
  it('finds matches recursively, skips node_modules and binaries, filters by glob', async () => {
    const out = await call('Grep', { pattern: 'needle' })
    expect(out.content).toContain('src/a.ts:2:export const needle = a')
    expect(out.content).toContain('src/deep/b.ts:1:needle again')
    expect(out.content).toContain('README.md:2')
    expect(out.content).not.toContain('node_modules')
    expect(out.content).not.toContain('bin.dat')
    const ts = await call('Grep', { pattern: 'needle', glob: '*.ts', path: 'src' })
    expect(ts.content).not.toContain('README')
    expect(ts.content).toContain('deep/b.ts')
    const single = await call('Grep', { pattern: 'hi', path: 'README.md' })
    expect(single.content).toContain('README.md:1:# hi')
  })
  it('reports no matches, invalid regex, and truncates', async () => {
    expect((await call('Grep', { pattern: 'zzz-none' })).content).toBe('No matches found')
    expect((await call('Grep', { pattern: '(' })).isError).toBe(true)
    fs.writeFileSync(path.join(cwd, 'many.txt'), Array.from({ length: 300 }, () => 'needle').join('\n'))
    expect((await call('Grep', { pattern: 'needle', path: 'many.txt' })).content).toContain('[truncated at 200 matches]')
  })
})

describe('Glob', () => {
  it('matches ** patterns and basenames', async () => {
    const out = await call('Glob', { pattern: 'src/**/*.ts' })
    expect(out.content.split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.ts'])
    expect((await call('Glob', { pattern: '*.md' })).content).toBe('README.md')
    expect((await call('Glob', { pattern: '*.py' })).content).toBe('No files found')
    expect((await call('Glob', { pattern: 'b.ts', path: 'src' })).content).toBe('src/deep/b.ts')
  })
  it('globToRegExp handles ?, {a,b} and unterminated braces', () => {
    expect(globToRegExp('a?c').test('abc')).toBe(true)
    expect(globToRegExp('*.{ts,js}').test('x.js')).toBe(true)
    expect(globToRegExp('*.{ts,js}').test('x.md')).toBe(false)
    expect(globToRegExp('x{').test('x{')).toBe(true)
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true)
  })
})

describe('Bash', () => {
  it('captures stdout+stderr, caps output, and times out', async () => {
    const ok = await call('Bash', { command: 'echo out; echo err 1>&2' })
    expect(ok).toEqual({ content: 'out\nerr', isError: false })
    const big = await call('Bash', { command: `head -c ${BASH_OUTPUT_CAP * 2} /dev/zero | tr '\\0' 'a'` })
    expect(big.content.length).toBeLessThan(BASH_OUTPUT_CAP + 200)
    expect(big.content).toContain('[output truncated')
    const slow = await call('Bash', { command: 'sleep 5', timeout: 200 })
    expect(slow.isError).toBe(true)
    expect(slow.content).toContain('timed out')
    expect((await call('Bash', { command: 'true' })).content).toBe('(no output)')
    expect((await call('Bash', { command: 5 })).isError).toBe(true)
  })
  it('shellCommand picks the platform shell', () => {
    const sc = shellCommand('ls')
    if (process.platform === 'win32') expect(sc.args).toEqual(['/d', '/s', '/c', 'ls'])
    else expect(sc).toEqual({ file: '/bin/sh', args: ['-c', 'ls'] })
  })
})

describe('Write / Edit', () => {
  it('writes with parent dirs, edits unique strings, replace_all, and error cases', async () => {
    expect((await call('Write', { file_path: 'new/dir/f.txt', content: 'aXbXc' })).isError).toBe(false)
    expect(fs.readFileSync(path.join(cwd, 'new/dir/f.txt'), 'utf8')).toBe('aXbXc')
    expect((await call('Edit', { file_path: 'new/dir/f.txt', old_string: 'X', new_string: 'Y' })).content).toContain('more than once')
    expect((await call('Edit', { file_path: 'new/dir/f.txt', old_string: 'X', new_string: 'Y', replace_all: true })).isError).toBe(false)
    expect(fs.readFileSync(path.join(cwd, 'new/dir/f.txt'), 'utf8')).toBe('aYbYc')
    expect((await call('Edit', { file_path: 'new/dir/f.txt', old_string: 'aY', new_string: 'Q' })).isError).toBe(false)
    expect(fs.readFileSync(path.join(cwd, 'new/dir/f.txt'), 'utf8')).toBe('QbYc')
    expect((await call('Edit', { file_path: 'new/dir/f.txt', old_string: 'zz', new_string: 'Q' })).content).toContain('not found')
    expect((await call('Edit', { file_path: 'new/dir/f.txt', old_string: '', new_string: 'Q' })).content).toContain('must not be empty')
    expect((await call('Edit', { file_path: 'missing.txt', old_string: 'a', new_string: 'b' })).isError).toBe(true)
    expect((await call('Write', { file_path: 'x', content: 1 })).content).toContain('must be a string')
  })
  it('confines writes to the roots (symlink escape included)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-out-'))
    fs.symlinkSync(outside, path.join(cwd, 'link'))
    const res = await call('Write', { file_path: 'link/pwned.txt', content: 'x' })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('path confinement')
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false)
    const abs = await call('Write', { file_path: path.join(outside, 'p2.txt'), content: 'x' })
    expect(abs.isError).toBe(true)
    fs.rmSync(outside, { recursive: true, force: true })
  })
  it('confinementRoots keeps a non-existent add-dir literally', () => {
    const roots = confinementRoots(cwd, ['/definitely/not/here'])
    expect(roots).toContain('/definitely/not/here')
  })
})

describe('SessionStore', () => {
  it('prunes beyond the LRU cap and resolves the default home', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-sessions-'))
    const store = new SessionStore(dir)
    const ids: string[] = []
    for (let i = 0; i < SESSION_LRU_CAP + 3; i++) {
      const s = store.create('m', cwd)
      ids.push(s.id)
      store.save(s)
      const t = new Date(Date.now() - (SESSION_LRU_CAP + 3 - i) * 1000)
      fs.utimesSync(path.join(dir, `${s.id}.json`), t, t)
    }
    const s = store.create('m', cwd)
    store.save(s)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(SESSION_LRU_CAP)
    expect(fs.existsSync(path.join(dir, `${ids[0]}.json`))).toBe(false)
    expect(store.load(s.id)).toMatchObject({ id: s.id, model: 'm' })
    expect(sessionsDir({})).toBe(path.join(os.homedir(), '.specrails', 'local-runner', 'sessions'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('commands', () => {
  it('detects and expands', () => {
    expect(detectSlashCommand('/specrails:implement 42 extra')).toEqual({ name: 'specrails:implement', args: '42 extra' })
    expect(detectSlashCommand('/plain')).toEqual({ name: 'plain', args: '' })
    expect(detectSlashCommand('hello /x')).toBeNull()
    expect(commandFilePath('/c', 'a:b')).toBe(path.join('/c', '.claude', 'commands', 'a', 'b.md'))
    expect(expandCommand('---\nx: 1\n---\nDo $ARGUMENTS and $ARGUMENTS', '7')).toBe('Do 7 and 7')
    expect(expandCommand('---\nunterminated', '7')).toBe('---\nunterminated')
  })
})

describe('FrameEmitter', () => {
  it('emits one JSON per line', () => {
    let out = ''
    const e = new FrameEmitter({ write: (c: string) => (out += c) })
    e.init('s', 'm')
    e.assistantText('id', 'm', 'hi')
    e.assistantToolUse('id', 'm', 't', 'Read', { file_path: 'x' }, { input_tokens: 1, output_tokens: 2 })
    e.toolResult('t', 'c', false)
    e.result({ sessionId: 's', isError: false, numTurns: 1, durationMs: 5, usage: { input_tokens: 1, output_tokens: 2 }, result: 'hi' })
    const lines = out.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(['system', 'assistant', 'assistant', 'user', 'result'])
    expect(lines[2].message.usage).toEqual({ input_tokens: 1, output_tokens: 2 })
    expect(lines[4]).not.toHaveProperty('reason')
  })
})
