import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  checkOverlayQuarantineTarget, deleteOverlayQuarantine, describeOverlayQuarantine, isOverlayQuarantineName, listOverlayQuarantines,
} from './overlay-quarantines'

let root: string
let worktreesRoot: string
let outside: string

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-quarantines-')))
  worktreesRoot = path.join(root, 'projects', 'demo', 'worktrees')
  outside = path.join(root, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  write(path.join(outside, 'precious.txt'), 'keep me\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function archive(relative: string): string {
  const dir = path.join(worktreesRoot, relative)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('overlay quarantines', () => {
  it('recognizes only exact mkdtemp archive names', () => {
    expect(isOverlayQuarantineName('ticket-14.specrails-overlay-quarantine-3VqEp0')).toBe(true)
    expect(isOverlayQuarantineName('ticket-14.specrails-overlay-quarantine-')).toBe(false)
    expect(isOverlayQuarantineName('ticket-14.specrails-overlay-quarantine-3VqEp0x')).toBe(false)
    expect(isOverlayQuarantineName('ticket-14')).toBe(false)
  })

  it('lists archives at run and repository depth, with files and sizes, never following links', () => {
    const a = archive('run-1/ticket-1.specrails-overlay-quarantine-AAAAAA')
    write(path.join(a, 'CLAUDE.md'), 'hello')
    fs.mkdirSync(path.join(a, '.claude'))
    fs.symlinkSync(outside, path.join(a, '.claude', 'commands'))
    const b = archive('repo-x/run-2/ticket-2.specrails-overlay-quarantine-BBBBBB')
    write(path.join(b, 'notes.md'), 'n')
    archive('run-1/ticket-1') // the worktree itself is not an archive

    const listed = listOverlayQuarantines(worktreesRoot)
    expect(listed.map((item) => item.path).sort()).toEqual([a, b].sort())
    const first = listed.find((item) => item.path === a)!
    expect(first.worktreeName).toBe('ticket-1')
    expect(first.fileCount).toBe(2)
    expect(first.files).toEqual([
      { path: '.claude/commands', kind: 'link', bytes: fs.lstatSync(path.join(a, '.claude', 'commands')).size },
      { path: 'CLAUDE.md', kind: 'file', bytes: 5 },
    ])
    expect(listOverlayQuarantines(path.join(root, 'missing'))).toEqual([])
  })

  it('deletes a confirmed archive without touching what its links point at', () => {
    const a = archive('run-1/ticket-1.specrails-overlay-quarantine-AAAAAA')
    write(path.join(a, 'CLAUDE.md'), 'hello')
    fs.symlinkSync(outside, path.join(a, 'link'))
    const lines: string[] = []
    const result = deleteOverlayQuarantine(worktreesRoot, a, { projectId: 'p1', log: (line) => lines.push(line) })
    expect(result).toMatchObject({ status: 'deleted', path: a, fileCount: 2 })
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me\n')
    expect(lines[0]).toMatch(/^\[overlay-quarantine\] deleted project=p1 /)
  })

  it('refuses anything that is not an archive of this project', () => {
    const log = () => {}
    const worktree = archive('run-1/ticket-1')
    expect(deleteOverlayQuarantine(worktreesRoot, worktree, { projectId: 'p1', log })).toMatchObject({ status: 'refused', reason: 'not-a-quarantine' })
    expect(fs.existsSync(worktree)).toBe(true)

    const foreign = path.join(outside, 'ticket-9.specrails-overlay-quarantine-CCCCCC')
    fs.mkdirSync(foreign)
    expect(deleteOverlayQuarantine(worktreesRoot, foreign, { projectId: 'p1', log })).toMatchObject({ status: 'refused', reason: 'outside-project' })
    expect(fs.existsSync(foreign)).toBe(true)

    // A link named like an archive, pointing outside, is refused (and never followed).
    const linkArchive = path.join(worktreesRoot, 'run-1', 'ticket-3.specrails-overlay-quarantine-DDDDDD')
    fs.symlinkSync(outside, linkArchive)
    expect(deleteOverlayQuarantine(worktreesRoot, linkArchive, { projectId: 'p1', log })).toMatchObject({ status: 'refused', reason: 'not-a-quarantine' })
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me\n')

    // A parent reached through a link that leaves the root is refused.
    fs.symlinkSync(outside, path.join(worktreesRoot, 'escape'))
    const viaLink = path.join(worktreesRoot, 'escape', 'ticket-9.specrails-overlay-quarantine-CCCCCC')
    expect(checkOverlayQuarantineTarget(worktreesRoot, viaLink)).toEqual({ ok: false, reason: 'outside-project' })

    expect(checkOverlayQuarantineTarget(worktreesRoot, 'relative/x.specrails-overlay-quarantine-AAAAAA')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkOverlayQuarantineTarget(worktreesRoot, 42)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkOverlayQuarantineTarget(worktreesRoot, path.join(worktreesRoot, 'run-1', 'gone.specrails-overlay-quarantine-EEEEEE'))).toEqual({ ok: false, reason: 'missing' })
    expect(describeOverlayQuarantine(linkArchive)).toBeNull()
  })
})
