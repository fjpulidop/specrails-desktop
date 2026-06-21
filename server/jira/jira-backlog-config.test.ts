import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
  backlogConfigPath,
  readBacklogConfig,
  writeJiraBacklogConfig,
  writeLocalBacklogConfig,
  type BacklogConfig,
} from './jira-backlog-config'

let projectDir: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-backlog-config-test-'))
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('backlogConfigPath', () => {
  it('returns <projectPath>/.specrails/backlog-config.json', () => {
    expect(backlogConfigPath(projectDir)).toBe(
      path.join(projectDir, '.specrails', 'backlog-config.json'),
    )
  })

  it('is a pure join (does not require the directory to exist)', () => {
    const made = backlogConfigPath('/nonexistent/project')
    expect(made).toBe(path.join('/nonexistent/project', '.specrails', 'backlog-config.json'))
    expect(fs.existsSync(made)).toBe(false)
  })
})

describe('readBacklogConfig', () => {
  it('returns null when the file is missing', () => {
    expect(readBacklogConfig(projectDir)).toBeNull()
  })

  it('returns null when the .specrails dir is missing', () => {
    // fresh temp dir has no .specrails subdir at all
    expect(fs.existsSync(path.join(projectDir, '.specrails'))).toBe(false)
    expect(readBacklogConfig(projectDir)).toBeNull()
  })

  it('returns null when the file is corrupt (invalid JSON)', () => {
    const target = backlogConfigPath(projectDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ this is not: valid json', 'utf-8')
    expect(readBacklogConfig(projectDir)).toBeNull()
  })

  it('returns null when the path points at a directory (read throws EISDIR)', () => {
    const target = backlogConfigPath(projectDir)
    fs.mkdirSync(target, { recursive: true })
    expect(readBacklogConfig(projectDir)).toBeNull()
  })

  it('parses and returns a valid config object', () => {
    const target = backlogConfigPath(projectDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const payload: BacklogConfig = { provider: 'local', write_access: true, git_auto: false }
    fs.writeFileSync(target, JSON.stringify(payload), 'utf-8')
    expect(readBacklogConfig(projectDir)).toEqual(payload)
  })
})

describe('writeJiraBacklogConfig', () => {
  it('writes { provider: local, write_access: false, git_auto: false } at the canonical path', () => {
    writeJiraBacklogConfig(projectDir)

    const target = backlogConfigPath(projectDir)
    expect(fs.existsSync(target)).toBe(true)

    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'))
    expect(parsed).toEqual({ provider: 'local', write_access: false, git_auto: false })
  })

  it('round-trips through readBacklogConfig', () => {
    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })

  it('creates the .specrails directory when missing', () => {
    expect(fs.existsSync(path.join(projectDir, '.specrails'))).toBe(false)
    writeJiraBacklogConfig(projectDir)
    expect(fs.existsSync(path.join(projectDir, '.specrails'))).toBe(true)
  })

  it('writes pretty-printed JSON (2-space indent)', () => {
    writeJiraBacklogConfig(projectDir)
    const raw = fs.readFileSync(backlogConfigPath(projectDir), 'utf-8')
    expect(raw).toBe(
      JSON.stringify({ provider: 'local', write_access: false, git_auto: false }, null, 2),
    )
  })

  it('leaves no temp file behind after the atomic rename', () => {
    writeJiraBacklogConfig(projectDir)
    const tmp = `${backlogConfigPath(projectDir)}.tmp`
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it('is idempotent: a second call does not rewrite the file (mtime stable)', () => {
    writeJiraBacklogConfig(projectDir)
    const target = backlogConfigPath(projectDir)
    const firstStat = fs.statSync(target)
    const firstContent = fs.readFileSync(target, 'utf-8')

    // Idempotent short-circuit reads existing config and returns early.
    writeJiraBacklogConfig(projectDir)
    const secondStat = fs.statSync(target)
    const secondContent = fs.readFileSync(target, 'utf-8')

    expect(secondContent).toBe(firstContent)
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs)
  })

  it('content stays stable across repeated idempotent calls', () => {
    writeJiraBacklogConfig(projectDir)
    writeJiraBacklogConfig(projectDir)
    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })

  it('overwrites a config that differs in write_access (flips back to read-only)', () => {
    // First put the project into write-access mode.
    writeLocalBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toMatchObject({ write_access: true })

    // Now the Jira write should NOT short-circuit (write_access differs) and must flip it.
    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })

  it('overwrites a config whose provider differs', () => {
    const target = backlogConfigPath(projectDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(
      target,
      JSON.stringify({ provider: 'jira', write_access: false, git_auto: false }),
      'utf-8',
    )

    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })

  it('rewrites when the existing file is corrupt (read returns null -> no short-circuit)', () => {
    const target = backlogConfigPath(projectDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'not json at all', 'utf-8')

    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })

  it('rewrites when only git_auto differs (BUG-JIRA-CLIENT-05): flips git_auto:true -> false', () => {
    // Regression guard: a pre-existing config that matches provider + write_access
    // but has git_auto:true (core would keep auto-committing) MUST be rewritten to
    // git_auto:false. The idempotency short-circuit now also compares git_auto.
    const target = backlogConfigPath(projectDir)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const stale = { provider: 'local', write_access: false, git_auto: true }
    fs.writeFileSync(target, JSON.stringify(stale), 'utf-8')

    writeJiraBacklogConfig(projectDir)

    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })

  it('still short-circuits (mtime stable) when ALL three fields already match', () => {
    writeJiraBacklogConfig(projectDir)
    const target = backlogConfigPath(projectDir)
    const firstStat = fs.statSync(target)

    writeJiraBacklogConfig(projectDir)
    const secondStat = fs.statSync(target)
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs)
  })
})

describe('writeLocalBacklogConfig', () => {
  it('writes { provider: local, write_access: true, git_auto: false }', () => {
    writeLocalBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: true,
      git_auto: false,
    })
  })

  it('creates the .specrails directory when missing', () => {
    expect(fs.existsSync(path.join(projectDir, '.specrails'))).toBe(false)
    writeLocalBacklogConfig(projectDir)
    expect(fs.existsSync(path.join(projectDir, '.specrails'))).toBe(true)
  })

  it('writes pretty-printed JSON (2-space indent)', () => {
    writeLocalBacklogConfig(projectDir)
    const raw = fs.readFileSync(backlogConfigPath(projectDir), 'utf-8')
    expect(raw).toBe(
      JSON.stringify({ provider: 'local', write_access: true, git_auto: false }, null, 2),
    )
  })

  it('leaves no temp file behind after the atomic rename', () => {
    writeLocalBacklogConfig(projectDir)
    const tmp = `${backlogConfigPath(projectDir)}.tmp`
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it('is NOT idempotent-guarded: it always overwrites (round-trips after each call)', () => {
    writeLocalBacklogConfig(projectDir)
    writeLocalBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: true,
      git_auto: false,
    })
  })

  it('flips a Jira read-only config back to write-access', () => {
    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toMatchObject({ write_access: false })

    writeLocalBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toMatchObject({ write_access: true })
  })
})

describe('round-trip toggling between Jira and local modes', () => {
  it('Jira -> local -> Jira preserves the expected final state', () => {
    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toMatchObject({ write_access: false })

    writeLocalBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toMatchObject({ write_access: true })

    writeJiraBacklogConfig(projectDir)
    expect(readBacklogConfig(projectDir)).toEqual({
      provider: 'local',
      write_access: false,
      git_auto: false,
    })
  })
})
