import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveCommand } from './command-resolver'

let tmpDir: string | null = null

function createTempDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-resolver-test-'))
  return tmpDir
}

function writeCommandFile(dir: string, relativePath: string, content: string): void {
  const fullPath = path.join(dir, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf-8')
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe('resolveCommand', () => {
  it('returns command as-is for non-slash commands', () => {
    const result = resolveCommand('just some text', '/any/cwd')
    expect(result).toBe('just some text')
  })

  it('returns command as-is when command file does not exist', () => {
    const dir = createTempDir()
    const result = resolveCommand('/specrails:missing-command hello', dir)
    expect(result).toBe('/specrails:missing-command hello')
  })

  it('uses a built-in Explore Spec fallback when the command file is unavailable', () => {
    const dir = createTempDir()
    const result = resolveCommand('/specrails:explore-spec quiero el juego del tetris', dir)
    expect(result).toContain('Explore Spec experience')
    expect(result).toContain('Do not use any local skill')
    expect(result).toContain('```spec-draft')
    expect(result).toContain('quiero el juego del tetris')
    // Non-goals ride in their own field, not inside the description (3.2).
    expect(result).toContain('"nonGoals": [')
    expect(result).not.toContain('## Out of Scope')
    expect(result).not.toBe('/specrails:explore-spec quiero el juego del tetris')
  })

  it('reads command file, strips frontmatter, substitutes $ARGUMENTS', () => {
    const dir = createTempDir()
    writeCommandFile(
      dir,
      '.claude/commands/specrails/test.md',
      `---
description: Test command
---

You are helping with: $ARGUMENTS

Do something.`
    )

    const result = resolveCommand('/specrails:test hello world', dir)
    expect(result).not.toContain('---')
    expect(result).not.toContain('description:')
    expect(result).toContain('hello world')
    expect(result).not.toContain('$ARGUMENTS')
    expect(result).toContain('You are helping with: hello world')
  })

  it('falls back to skills directory if commands file not found', () => {
    const dir = createTempDir()
    writeCommandFile(
      dir,
      '.claude/skills/specrails/skill-cmd.md',
      `---
description: A skill
---

Skill prompt with args: $ARGUMENTS`
    )

    const result = resolveCommand('/specrails:skill-cmd the-arg', dir)
    expect(result).toContain('the-arg')
    expect(result).not.toContain('$ARGUMENTS')
    expect(result).not.toContain('description:')
  })

  it('substitutes all occurrences of $ARGUMENTS', () => {
    const dir = createTempDir()
    writeCommandFile(
      dir,
      '.claude/commands/specrails/multi.md',
      `---
description: Multi sub
---

First: $ARGUMENTS
Second: $ARGUMENTS`
    )

    const result = resolveCommand('/specrails:multi myarg', dir)
    expect(result).toBe('First: myarg\nSecond: myarg')
  })

  it('handles command with no arguments (empty $ARGUMENTS substitution)', () => {
    const dir = createTempDir()
    writeCommandFile(
      dir,
      '.claude/commands/specrails/noargs.md',
      `---
description: No args
---

Do this: $ARGUMENTS`
    )

    const result = resolveCommand('/specrails:noargs', dir)
    expect(result).toBe('Do this:')
  })

  it('rejects path-traversal segments and never reads outside the commands dir', () => {
    const dir = createTempDir()
    fs.writeFileSync(path.join(dir, 'secret.md'), 'TOP SECRET', 'utf-8')
    // Without the guard, `..:..:secret` joins to <dir>/.claude/commands/../../secret.md = <dir>/secret.md
    const malicious = '/..:..:secret arg'
    const result = resolveCommand(malicious, dir)
    expect(result).toBe(malicious) // unresolved — guard refused to traverse
    expect(result).not.toContain('TOP SECRET')
  })

  it('rejects a segment containing a path separator', () => {
    const dir = createTempDir()
    const result = resolveCommand('/specrails:sub/evil hi', dir)
    expect(result).toBe('/specrails:sub/evil hi')
  })

  it('commands directory takes priority over skills directory', () => {
    const dir = createTempDir()
    writeCommandFile(
      dir,
      '.claude/commands/specrails/both.md',
      `---
description: Commands version
---

From commands: $ARGUMENTS`
    )
    writeCommandFile(
      dir,
      '.claude/skills/specrails/both.md',
      `---
description: Skills version
---

From skills: $ARGUMENTS`
    )

    const result = resolveCommand('/specrails:both test', dir)
    expect(result).toBe('From commands: test')
  })
})
