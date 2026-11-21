import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mirrorProjectEntry, resolveHome, workspaceLayout } from './artifact-registry'
import { mutateStore, readStore } from './modules/specs/runtime/ticket-store'
import { resolveProjectExecution, resolveProjectTicketsPath } from './workspace-resolution'
import { adoptPreAssemblySpecs } from './pre-assembly-specs'

let home: string
let repo: string
let priorHome: string | undefined
const project = () => ({ slug: 'acme', path: repo })

beforeEach(() => {
  priorHome = process.env.SPECRAILS_REGISTRY_HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-assembly-home-')))
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-assembly-repo-')))
  process.env.SPECRAILS_REGISTRY_HOME = home
  mirrorProjectEntry({ repoPath: repo, slug: 'acme', providers: ['claude'], desktopProjectId: 'p1' })
})
afterEach(() => {
  if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = priorHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

function populate(): string {
  const ws = workspaceLayout(resolveHome(), 'acme', repo).workspaceDir
  fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '6.11.1\n')
  return ws
}
function addSpec(file: string, title: string): void {
  mutateStore(file, (s) => { const id = s.next_id++; s.tickets[String(id)] = { id, title, status: 'on_review' } as never })
}

describe('adoptPreAssemblySpecs', () => {
  it('moves a spec an earlier build wrote to the repository before population, keeping its id', () => {
    const before = resolveProjectExecution(project())
    expect(before.relocated).toBe(false)
    addSpec(path.join(repo, '.specrails', 'local-tickets.json'), 'Created during assembly')
    populate()
    expect(adoptPreAssemblySpecs(project())).toBe('adopted')
    const after = resolveProjectExecution(project())
    expect(after.relocated).toBe(true)
    const store = readStore(after.ticketsPath)
    expect(store.tickets['1']).toMatchObject({ id: 1, title: 'Created during assembly' })
    expect(store.next_id).toBe(2)
    expect(fs.existsSync(path.join(repo, '.specrails', 'local-tickets.json'))).toBe(false)
    expect(adoptPreAssemblySpecs(project())).toBe('none')
  })

  it('never merges into a workspace that already has specs', () => {
    addSpec(path.join(repo, '.specrails', 'local-tickets.json'), 'In repo')
    const ws = populate()
    addSpec(path.join(ws, '.specrails', 'local-tickets.json'), 'In workspace')
    expect(adoptPreAssemblySpecs(project())).toBe('kept')
    expect(readStore(path.join(repo, '.specrails', 'local-tickets.json')).tickets['1'].title).toBe('In repo')
  })

  it('leaves a repository with its own in-repo install alone, and does nothing before population', () => {
    addSpec(path.join(repo, '.specrails', 'local-tickets.json'), 'Legacy')
    expect(adoptPreAssemblySpecs(project())).toBe('none')
    populate()
    fs.writeFileSync(path.join(repo, '.specrails', 'specrails-version'), '4.0.0\n')
    expect(adoptPreAssemblySpecs(project())).toBe('none')
  })
})

describe('the spec store of a project still being assembled', () => {
  it('is the workspace store from the first spec, so specs created on either side of the flip stay together', () => {
    // Core writes the workspace marker part-way through assembly. Specs created
    // before and after that instant used to land in two files; the repository
    // ones then vanished from the board and their ids were reused.
    const early = resolveProjectTicketsPath(project())
    addSpec(early, 'Before Core started')
    addSpec(resolveProjectTicketsPath(project()), 'While Core installs')
    const ws = populate() // the marker lands: the gate flips mid-assembly
    expect(resolveProjectExecution(project()).relocated).toBe(true)
    addSpec(resolveProjectTicketsPath(project()), 'Right after the marker')
    // The first provider's callback finds nothing to adopt and moves nothing.
    expect(adoptPreAssemblySpecs(project())).toBe('none')

    const file = resolveProjectTicketsPath(project())
    expect(file).toBe(early)
    expect(file).toBe(path.join(ws, '.specrails', 'local-tickets.json'))
    const store = readStore(file)
    expect(Object.values(store.tickets).map(t => [t.id, t.title])).toEqual([
      [1, 'Before Core started'], [2, 'While Core installs'], [3, 'Right after the marker'],
    ])
    expect(store.next_id).toBe(4)
    expect(fs.existsSync(path.join(repo, '.specrails'))).toBe(false)
  })

  it('hands the same store to agents spawned from the repository before population', () => {
    const exec = resolveProjectExecution(project())
    expect(exec.relocated).toBe(false)
    expect(exec.cwd).toBe(repo)
    expect(exec.ticketsPath).toBe(resolveProjectTicketsPath(project()))
    expect(exec.env).toEqual({ SPECRAILS_TICKETS_PATH: exec.ticketsPath })
  })

  it('keeps the in-repo store for an in-repo install, an integration contract, specs already in the repository, or no registry entry', () => {
    const inRepo = path.join(repo, '.specrails', 'local-tickets.json')
    fs.mkdirSync(path.join(repo, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.specrails', 'specrails-version'), '4.0.0\n')
    expect(resolveProjectTicketsPath(project())).toBe(inRepo)
    expect(resolveProjectExecution(project()).env).toEqual({})
    fs.rmSync(path.join(repo, '.specrails', 'specrails-version'))

    addSpec(inRepo, 'Written by an earlier build')
    expect(resolveProjectTicketsPath(project())).toBe(inRepo)
    fs.rmSync(inRepo)

    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude', 'integration-contract.json'), JSON.stringify({ ticketProvider: { storagePath: 'backlog/tickets.json' } }))
    expect(resolveProjectTicketsPath(project())).toBe(path.join(repo, 'backlog', 'tickets.json'))
    fs.rmSync(path.join(repo, '.claude'), { recursive: true })

    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-assembly-unregistered-')))
    try {
      expect(resolveProjectTicketsPath({ slug: 'x', path: other })).toBe(path.join(other, '.specrails', 'local-tickets.json'))
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
