import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addProject, initDesktopDb, type ProjectRow } from './desktop-db'
import { createJob, initDb, type DbInstance } from './db'
import type { ProjectContext } from './project-registry'
import type { AgentMessage } from './agent-store'
import { resolveTicketStoragePath } from './ticket-store'
import { buildAgentHistoryBlock, buildAgentProjectContextBlock, buildResolvedAgentContextBlock, type AgentContextReference, type AgentContextRegistry } from './agent-context-resolver'

describe('agent project context isolation', () => {
  let home: string
  let desktopDb: DbInstance
  let projects: ProjectRow[]
  let contexts: ProjectContext[]
  let registry: AgentContextRegistry

  function writeTicket(project: ProjectRow, title: string) {
    const file = resolveTicketStoragePath(project.path)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ schema_version: '1.1', revision: 0, next_id: 2, tickets: { '1': {
      id: 1, title, description: 'Expected behavior', status: 'todo', priority: 'medium',
      created_at: '2026-01-01', updated_at: '2026-01-01',
    } } }))
  }

  const ref = (projectId?: string): AgentContextReference => ({ kind: 'spec', id: '1', label: 'Spec 1', token: '#1', ...(projectId ? { scope: { projectId } } : {}) })

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-agent-context-'))
    desktopDb = initDesktopDb(':memory:')
    projects = ['a', 'b'].map((id) => addProject(desktopDb, { id, slug: id, name: `Project ${id}`, path: path.join(home, id), providers: ['claude', 'codex'] }))
    contexts = projects.map((project) => ({ project, db: initDb(':memory:') } as ProjectContext))
    registry = {
      getContext: (id) => contexts.find((context) => context.project.id === id),
      getProjectRow: (id) => projects.find((project) => project.id === id),
      listContexts: () => contexts,
    }
  })

  afterEach(() => {
    for (const context of contexts) context.db.close()
    desktopDb.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('never replaces a missing explicitly scoped spec with another project spec', () => {
    writeTicket(projects[1], 'Only in B')
    const block = buildResolvedAgentContextBlock([ref('a')], { desktopDb, registry })
    expect(block).toContain('not found in the requested project')
    expect(block).not.toContain('Only in B')
  })

  it('reports an unreadable scoped store as an error rather than a missing spec or cross-project fallback', () => {
    writeTicket(projects[0], 'Original A spec')
    writeTicket(projects[1], 'Only in B')
    fs.writeFileSync(resolveTicketStoragePath(projects[0].path), '{broken')
    const block = buildResolvedAgentContextBlock([ref('a')], { desktopDb, registry })
    expect(block).toContain('resolution_error:')
    expect(block).toContain('invalid JSON')
    expect(block).not.toContain('not found')
    expect(block).not.toContain('Only in B')
  })

  it('keeps an unscoped spec inside the pinned project and reports ambiguous Home numbers', () => {
    writeTicket(projects[0], 'A specification')
    writeTicket(projects[1], 'B specification')
    const pinned = buildResolvedAgentContextBlock([ref()], { desktopDb, registry, fallbackProjectId: 'b' })
    expect(pinned).toContain('B specification')
    expect(pinned).not.toContain('A specification')
    const homeBlock = buildResolvedAgentContextBlock([ref()], { desktopDb, registry })
    expect(homeBlock).toContain('ambiguous across projects')
    expect(homeBlock).not.toContain('A specification')
    expect(homeBlock).not.toContain('B specification')
  })

  it('retains same-numbered chips from two explicitly selected projects', () => {
    writeTicket(projects[0], 'A specification')
    writeTicket(projects[1], 'B specification')
    const block = buildResolvedAgentContextBlock([ref('a'), ref('b'), ref('a')], { desktopDb, registry })
    expect(block).toContain('A specification')
    expect(block).toContain('B specification')
    expect(block.match(/spec.id: #1/g)).toHaveLength(2)
  })

  it('preserves same-path file references across repositories and refuses foreign repository scopes', () => {
    const project = projects[0]
    project.repositories = ['frontend', 'backend'].map((id, index) => {
      const directory = path.join(home, id)
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(directory, 'index.ts'), id)
      return { id, projectId: project.id, path: directory, name: id, kind: 'folder', isPrimary: index === 0, addedAt: '', integrationBranch: null }
    })
    const refs = project.repositories.map(repository => ({ kind: 'file', id: 'index.ts', label: 'index.ts', token: '@index.ts', scope: { projectId: project.id, repositoryId: repository.id } }))
    const block = buildResolvedAgentContextBlock(refs, { desktopDb, registry })
    expect(block.match(/resolution: scoped file reference/g)).toHaveLength(2)
    expect(block).toContain('repository.name: backend')
    const foreign = buildResolvedAgentContextBlock([{ ...refs[0], scope: { projectId: 'a', repositoryId: 'foreign' } }], { desktopDb, registry })
    expect(foreign).toContain('resolution_error: Repository does not belong')
    const ambiguous = buildResolvedAgentContextBlock([{ ...refs[0], scope: { projectId: 'a' } }], { desktopDb, registry })
    expect(ambiguous).toContain('repository required')
    expect(buildAgentProjectContextBlock({ desktopDb, registry, fallbackProjectId: 'a' })).toContain('Historical specs without repositoryIds target only the primary')
  })

  it('does not cross project boundaries for jobs or parse malformed spec ids as valid numbers', () => {
    createJob(contexts[1].db, { id: 'job-1', command: 'B-only command', started_at: '2026-01-01' })
    const job = buildResolvedAgentContextBlock([{ ...ref('a'), kind: 'job', id: 'job-1' }], { desktopDb, registry })
    expect(job).toContain('job job-1 not found')
    expect(job).not.toContain('B-only command')
    writeTicket(projects[0], 'Valid spec')
    const invalid = buildResolvedAgentContextBlock([{ ...ref('a'), id: '1junk' }], { desktopDb, registry })
    expect(invalid).toContain('unresolved spec id')
    expect(invalid).not.toContain('Valid spec')
  })

  it('provides a compact pin snapshot without requiring explicit chips', () => {
    writeTicket(projects[0], 'Pinned backlog item')
    const block = buildAgentProjectContextBlock({ desktopDb, registry, fallbackProjectId: 'a' })
    expect(block).toContain('project.id: a')
    expect(block).toContain('Project a')
    expect(block).toContain(projects[0].path)
    expect(block).toContain('claude, codex')
    expect(block).toContain('Pinned backlog item')
    expect(block).toContain('project.runtime: available')
    expect(block).not.toContain('Project b')
    expect(block.length).toBeLessThan(6700)
  })

  it('lists the persisted Home catalog even when a project context is unavailable', () => {
    const block = buildAgentProjectContextBlock({ desktopDb, registry: { ...registry, getContext: () => undefined, listContexts: () => [] } })
    expect(block).toContain('registered.projects.total: 2')
    expect(block).toContain('"projectId":"a"')
    expect(block).toContain('"projectId":"b"')
    const unavailable = buildAgentProjectContextBlock({ desktopDb, registry: { ...registry, getContext: () => undefined }, fallbackProjectId: 'a' })
    expect(unavailable).toContain('project.runtime: unavailable')
    expect(unavailable).toContain('do not interpret this as a deleted project')
  })
})

describe('agent fresh-session history', () => {
  it('retains recent scoped references and attachment provenance within a bounded history', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), conversation_id: 'conversation', role: i % 2 ? 'assistant' : 'user',
      content: `${i} ${'x'.repeat(5000)}`, created_at: '', attachment_ids: i === 19 ? ['attachment-19'] : [],
      context_refs: i === 19 ? [{ kind: 'spec', id: '1', label: '#1', token: '#1', scope: { projectId: 'b', repositoryId: 'backend' } }] : [],
    } as AgentMessage))
    const block = buildAgentHistoryBlock(messages)
    expect(block).toContain('19 xxx')
    expect(block).toContain('"projectId":"b"')
    expect(block).toContain('"repositoryId":"backend"')
    expect(block).toContain('Historical attachment content is not included.')
    expect(block).toContain('do not repeat completed actions')
    expect(block).toContain('earlier content may be omitted')
    expect(block.length).toBeLessThan(18000)
    expect(buildAgentHistoryBlock([])).toBe('')
  })
})
