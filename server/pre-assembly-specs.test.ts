import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mirrorProjectEntry, resolveHome, workspaceLayout } from './artifact-registry'
import { mutateStore, readStore } from './modules/specs/runtime/ticket-store'
import { resolveProjectExecution } from './workspace-resolution'
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
  it('moves a spec created before the workspace was populated, keeping its id', () => {
    const before = resolveProjectExecution(project())
    expect(before.relocated).toBe(false)
    addSpec(before.ticketsPath, 'Created during assembly')
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
