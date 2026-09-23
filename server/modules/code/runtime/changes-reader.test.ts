import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readChanges } from './changes-reader'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-test-'))
}

function makeChange(
  changesDir: string,
  id: string,
  artifacts: { proposal?: boolean; design?: boolean; tasks?: boolean } = {},
  meta?: { created?: string; archived?: string }
) {
  const changeDir = path.join(changesDir, id)
  fs.mkdirSync(changeDir, { recursive: true })
  if (artifacts.proposal) fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# Proposal')
  if (artifacts.design) fs.writeFileSync(path.join(changeDir, 'design.md'), '# Design')
  if (artifacts.tasks) fs.writeFileSync(path.join(changeDir, 'tasks.md'), '# Tasks')
  if (meta) {
    const lines = Object.entries(meta)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
    fs.writeFileSync(path.join(changeDir, '.openspec.yaml'), lines)
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('readChanges', () => {
  let tmpDir: string
  let changesDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    changesDir = path.join(tmpDir, 'openspec', 'changes')
    fs.mkdirSync(changesDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when openspec/changes directory does not exist', () => {
    const result = readChanges('/non-existent-path-xyz')
    expect(result).toEqual([])
  })

  it('classifies a change with only proposal.md as exploring', () => {
    makeChange(changesDir, 'spea-001-my-feature', { proposal: true })
    const changes = readChanges(tmpDir)
    expect(changes).toHaveLength(1)
    expect(changes[0].phase).toBe('exploring')
    expect(changes[0].id).toBe('spea-001-my-feature')
    expect(changes[0].name).toBe('My Feature')
    expect(changes[0].artifacts.proposal).toBe(true)
    expect(changes[0].artifacts.design).toBe(false)
    expect(changes[0].artifacts.tasks).toBe(false)
  })

  it('classifies a change with design.md as designing', () => {
    makeChange(changesDir, 'spea-002-auth-rework', { proposal: true, design: true })
    const changes = readChanges(tmpDir)
    expect(changes[0].phase).toBe('designing')
    expect(changes[0].artifacts.design).toBe(true)
  })

  it('classifies a change with tasks.md and no active job as ready', () => {
    makeChange(changesDir, 'spea-003-new-api', { proposal: true, design: true, tasks: true })
    const changes = readChanges(tmpDir)
    expect(changes[0].phase).toBe('ready')
  })

  it('classifies a change with tasks.md and matching active job command as building', () => {
    makeChange(changesDir, 'spea-003-new-api', { proposal: true, design: true, tasks: true })
    const activeCommands = ['/opsx:apply spea-003-new-api']
    const changes = readChanges(tmpDir, activeCommands)
    expect(changes[0].phase).toBe('building')
  })

  it('classifies archived changes as shipped', () => {
    const archiveDir = path.join(changesDir, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    makeChange(archiveDir, 'spea-000-old-feature', { proposal: true, design: true, tasks: true })
    const changes = readChanges(tmpDir)
    expect(changes).toHaveLength(1)
    expect(changes[0].phase).toBe('shipped')
    expect(changes[0].isArchived).toBe(true)
  })

  it('does not include the archive directory itself as a change', () => {
    const archiveDir = path.join(changesDir, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    makeChange(changesDir, 'spea-004-feature', { proposal: true })
    const changes = readChanges(tmpDir)
    // Only spea-004-feature, not archive
    expect(changes.every((c) => c.id !== 'archive')).toBe(true)
  })

  it('reads createdAt from .openspec.yaml', () => {
    makeChange(changesDir, 'spea-005-dated', { proposal: true }, { created: '2026-03-15' })
    const changes = readChanges(tmpDir)
    expect(changes[0].createdAt).toBe('2026-03-15')
  })

  it('handles multiple changes across phases', () => {
    makeChange(changesDir, 'spea-010-explore', { proposal: true })
    makeChange(changesDir, 'spea-011-design', { proposal: true, design: true })
    makeChange(changesDir, 'spea-012-ready', { proposal: true, design: true, tasks: true })
    const archiveDir = path.join(changesDir, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    makeChange(archiveDir, 'spea-009-shipped', { proposal: true, tasks: true })

    const changes = readChanges(tmpDir)
    expect(changes).toHaveLength(4)

    const phases = changes.map((c) => c.phase).sort()
    expect(phases).toEqual(['designing', 'exploring', 'ready', 'shipped'].sort())
  })

  it('converts change id to human-readable name', () => {
    makeChange(changesDir, 'spea-123-feature-funnel-view', { proposal: true })
    const changes = readChanges(tmpDir)
    expect(changes[0].name).toBe('Feature Funnel View')
  })
})
