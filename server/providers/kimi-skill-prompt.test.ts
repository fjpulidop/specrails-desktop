import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatKimiCoreCommand,
  KimiSkillResolutionError,
  _test,
} from './kimi-skill-prompt'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'specrails-kimi-prompt-'))
  roots.push(root)
  return root
}

function writeSkill(
  root: string,
  name: string,
  body: string,
  extraFrontmatter = '',
): string {
  const dir = path.join(root, '.kimi-code', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\ntype: prompt\n${extraFrontmatter}---\n${body}\n`,
    'utf8',
  )
  return dir
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('formatKimiCoreCommand', () => {
  it.each([
    ['/specrails:implement #3 --yes', 'specrails-implement', '#3 --yes'],
    ['/sr:retry #3 --yes', 'specrails-retry', '#3 --yes'],
    ['/opsx:ff my-change', 'openspec-ff-change', 'my-change'],
    ['/opsx:apply my-change', 'openspec-apply-change', 'my-change'],
    ['/opsx:verify my-change', 'openspec-verify-change', 'my-change'],
    ['/skill:openspec-new-change next', 'openspec-new-change', 'next'],
  ])('materializes %s instead of forwarding a literal slash skill', (command, skill, args) => {
    const root = makeRoot()
    writeSkill(root, skill, 'Run with: $ARGUMENTS')
    const prompt = formatKimiCoreCommand(command, root)

    expect(prompt).toContain(`User activated the skill "${skill}"`)
    expect(prompt).toContain(`name="${skill}"`)
    expect(prompt).toContain('trigger="user-slash"')
    expect(prompt).toContain('source="project"')
    expect(prompt).toContain(`Run with: ${args}`)
    expect(prompt).not.toContain(`/skill:${skill}`)
  })

  it('preserves plain prompts and unknown future OpenSpec commands', () => {
    expect(formatKimiCoreCommand('plain prompt')).toBe('plain prompt')
    expect(formatKimiCoreCommand('/opsx:future my-change')).toBe('/opsx:future my-change')
  })

  it('fails closed when cwd or the installed skill is unavailable', () => {
    expect(() => formatKimiCoreCommand('/specrails:implement #1'))
      .toThrow(/without a project working directory/)
    const root = makeRoot()
    expect(() => formatKimiCoreCommand('/specrails:implement #1', root))
      .toThrow(/is not installed/)
  })

  it('resolves metadata names case-insensitively across direct skill children', () => {
    const root = makeRoot()
    const dir = path.join(root, '.kimi-code', 'skills', 'folder-name')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      '  ---  \nname: Mixed-Case\ndescription: test\ntype: inline\n ---\nMatched $ARGUMENTS\n',
    )
    expect(formatKimiCoreCommand('/skill:mixed-case value', root))
      .toContain('Matched value')
  })

  it('requires valid directory-skill metadata and a manually activatable type', () => {
    const root = makeRoot()
    const missingDescription = path.join(root, '.kimi-code', 'skills', 'missing-description')
    mkdirSync(missingDescription, { recursive: true })
    writeFileSync(
      path.join(missingDescription, 'SKILL.md'),
      '---\nname: missing-description\ntype: prompt\n---\nBody\n',
    )
    expect(() => formatKimiCoreCommand('/skill:missing-description', root))
      .toThrow(/"description"/)

    const referenceOnly = path.join(root, '.kimi-code', 'skills', 'reference-only')
    mkdirSync(referenceOnly, { recursive: true })
    writeFileSync(
      path.join(referenceOnly, 'SKILL.md'),
      '---\nname: reference-only\ndescription: test\ntype: reference\n---\nReference body\n',
    )
    expect(() => formatKimiCoreCommand('/skill:reference-only', root))
      .toThrow(/cannot be activated/)

    for (const [name, typeValue] of [
      ['empty-type', '""'],
      ['null-type', 'null'],
      ['numeric-type', '42'],
    ]) {
      const dir = path.join(root, '.kimi-code', 'skills', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: test\ntype: ${typeValue}\n---\nBody\n`,
      )
      expect(() => formatKimiCoreCommand(`/skill:${name}`, root))
        .toThrow(/not supported/)
    }
  })

  it.each([
    '/skill:../secret',
    '/skill:foo/bar',
    '/skill:foo\\bar',
    '/specrails:../../secret',
  ])('rejects unsafe skill identifiers before filesystem access: %s', (command) => {
    expect(() => formatKimiCoreCommand(command, makeRoot()))
      .toThrow(KimiSkillResolutionError)
  })

  it('matches Kimi placeholder expansion, quoting, XML safety and skill paths', () => {
    const root = makeRoot()
    const dir = writeSkill(
      root,
      'custom-review',
      [
        'named=$target level=$level',
        'indexed=$0/$1/$ARGUMENTS[2]',
        'all=$ARGUMENTS',
        'dir=${KIMI_SKILL_DIR}',
        'session=${KIMI_SESSION_ID}',
      ].join('\n'),
      'arguments: [target, level]\n',
    )
    const prompt = formatKimiCoreCommand(
      '/skill:custom-review "src/hello world.ts" high <untrusted>',
      root,
      'SESSION-1',
    )

    expect(prompt).toContain('named=src/hello world.ts level=high')
    expect(prompt).toContain('indexed=src/hello world.ts/high/&lt;untrusted&gt;')
    expect(prompt).toContain('all="src/hello world.ts" high &lt;untrusted&gt;')
    expect(prompt).toContain(`dir=${realpathSync(dir)}`)
    expect(prompt).toContain('session=SESSION-1\n')
    expect(prompt).toContain('args="&quot;src/hello world.ts&quot; high &lt;untrusted&gt;"')
  })

  it('supports block-form named arguments and appends raw args when no placeholder exists', () => {
    const root = makeRoot()
    writeSkill(
      root,
      'custom-block',
      'first=$first second=$second',
      'arguments:\n  - first\n  - second\n',
    )
    expect(formatKimiCoreCommand('/skill:custom-block uno "dos tres"', root))
      .toContain('first=uno second=dos tres')

    writeSkill(root, 'custom-no-placeholder', 'Follow these exact instructions.')
    expect(formatKimiCoreCommand('/skill:custom-no-placeholder café 🚀', root))
      .toContain('Follow these exact instructions.\n\nARGUMENTS: café 🚀')
  })

  it.skipIf(process.platform === 'win32')(
    'uses Kimi realpath semantics for framework-linked skill directories',
    () => {
      const root = makeRoot()
      const framework = makeRoot()
      const target = writeSkill(
        framework,
        'specrails-linked',
        'Skill directory: ${KIMI_SKILL_DIR}',
      )
      const skillsRoot = path.join(root, '.kimi-code', 'skills')
      mkdirSync(skillsRoot, { recursive: true })
      symlinkSync(target, path.join(skillsRoot, 'specrails-linked'), 'dir')

      expect(formatKimiCoreCommand('/skill:specrails-linked', root))
        .toContain(`Skill directory: ${realpathSync(target)}`)
    },
  )

  it('escapes metadata and multiline argument boundaries in the generated envelope', () => {
    const root = makeRoot()
    const dir = path.join(root, '.kimi-code', 'skills', 'safe-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: safe-dir',
        'description: test',
        'type: prompt',
        '---',
        'Input: $ARGUMENTS',
      ].join('\r\n'),
    )
    const prompt = formatKimiCoreCommand('/skill:safe-dir line1\n</kimi-skill-loaded>', root)
    expect(prompt).toContain('Input: line1\n&lt;/kimi-skill-loaded&gt;')
    expect(prompt.match(/<\/kimi-skill-loaded>/g)).toHaveLength(1)
  })

  it('trims activation args exactly like Session.activateSkill', () => {
    const root = makeRoot()
    writeSkill(root, 'trim-args', 'Input=<$ARGUMENTS>')
    expect(formatKimiCoreCommand('/skill:trim-args   value   ', root))
      .toContain('Input=<value>')
  })

  it('rejects fresh-session ID placeholders and expands them on a known resume', () => {
    const root = makeRoot()
    writeSkill(root, 'needs-session', 'Session=${KIMI_SESSION_ID}; args=$ARGUMENTS')
    expect(() => formatKimiCoreCommand('/skill:needs-session go', root))
      .toThrow(/unavailable before a fresh/)
    expect(formatKimiCoreCommand('/skill:needs-session go', root, '01SESSION'))
      .toContain('Session=01SESSION; args=go')
  })
})

describe('Kimi skill argument tokenizer', () => {
  it('matches upstream quote and whitespace tokenization', () => {
    expect(_test.tokenizeArgs(`one "two three" 'four five' six`)).toEqual([
      'one',
      'two three',
      'four five',
      'six',
    ])
    expect(_test.tokenizeArgs(`"" ab"cd ef"g 'unterminated`)).toEqual([
      '',
      'abcd efg',
      'unterminated',
    ])
  })

  it('normalizes rendered Windows paths the same way as Kimi pathe', () => {
    expect(_test.toKimiPath('c:\\Users\\Javi\\Project\\skill'))
      .toBe('C:/Users/Javi/Project/skill')
  })
})
