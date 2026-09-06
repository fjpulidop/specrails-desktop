import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureOpenSpecRuntimePluginForArgs, getOpenSpecRuntimePluginArgs } from './openspec-runtime-plugin'
import templates from './openspec-runtime-plugin-commands.json'

const homes: string[] = []
const home = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-opsx-runtime-')); homes.push(directory); return directory }
afterEach(() => { for (const directory of homes.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('managed OpenSpec runtime plugin', () => {
  it('computes arguments without writes, then projects exact names/content privately and idempotently', () => {
    const root = home(), args = getOpenSpecRuntimePluginArgs(root), plugin = args[1]
    expect(args[0]).toBe('--plugin-dir')
    expect(fs.readdirSync(root)).toEqual([])
    ensureOpenSpecRuntimePluginForArgs(args, root)
    expect(JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8'))).toMatchObject({ name: 'opsx', license: 'MIT' })
    expect(fs.readdirSync(path.join(plugin, 'commands'))).toEqual(Object.keys(templates.commands).map(name => `${name}.md`).sort())
    for (const [name, content] of Object.entries(templates.commands)) {
      const actual = fs.readFileSync(path.join(plugin, 'commands', `${name}.md`), 'utf8')
      expect(actual).toBe(content.replace(/^(---\r?\n)name:[^\r\n]*/, `$1name: ${name}`))
      expect(actual.split('\n')[1]).toBe(`name: ${name}`)
      expect(actual.split('\n').slice(2)).toEqual(content.split('\n').slice(2))
    }
    const before = fs.statSync(path.join(plugin, 'commands/ff.md')).mtimeMs
    ensureOpenSpecRuntimePluginForArgs(['-p', 'unrelated', ...args], root)
    expect(fs.statSync(path.join(plugin, 'commands/ff.md')).mtimeMs).toBe(before)
    expect(fs.readdirSync(path.dirname(plugin))).toEqual([path.basename(plugin)])
    if (process.platform !== 'win32') expect(fs.statSync(path.join(plugin, 'commands/ff.md')).mode & 0o777).toBe(0o600)
  })

  it.each(['truncated', 'missing', 'unexpected hooks', 'symlink'])('rejects a %s cache before launching instead of accepting or overwriting it', kind => {
    const root = home(), args = getOpenSpecRuntimePluginArgs(root), file = path.join(args[1], 'commands/ff.md')
    ensureOpenSpecRuntimePluginForArgs(args, root)
    if (kind === 'truncated') fs.writeFileSync(file, 'broken')
    if (kind === 'missing') fs.unlinkSync(file)
    if (kind === 'unexpected hooks') fs.mkdirSync(path.join(args[1], 'hooks'))
    if (kind === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(args[1], 'commands/apply.md'), file) }
    expect(() => ensureOpenSpecRuntimePluginForArgs(args, root)).toThrow('No AI process was started')
    if (kind === 'truncated') expect(fs.readFileSync(file, 'utf8')).toBe('broken')
  })

  it('does not touch arbitrary plugin paths or a symlinked cache namespace', () => {
    const root = home(), foreign = home()
    ensureOpenSpecRuntimePluginForArgs(['--plugin-dir', foreign], root)
    expect(fs.readdirSync(root)).toEqual([])
    fs.mkdirSync(path.join(root, '.specrails'))
    fs.symlinkSync(foreign, path.join(root, '.specrails/runtime-plugins'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => ensureOpenSpecRuntimePluginForArgs(getOpenSpecRuntimePluginArgs(root), root)).toThrow('regular directory')
    expect(fs.readdirSync(foreign)).toEqual([])
  })
})
