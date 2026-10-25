import {
  SAMPLE_PARENT_DIR_NAME, SampleError, firstFreeName, isStrictlyInside,
  type SampleDefinition, type SampleLocale, type SampleRecord,
} from './domain'
import type { SampleFilesPort, SampleGitPort, SampleProjectRef, SampleProjectsPort, SampleSpecsPort, SampleStatePort } from './ports'

export interface SampleDeps {
  samples: readonly SampleDefinition[]
  files: SampleFilesPort
  git: SampleGitPort
  specs: SampleSpecsPort
  projects: SampleProjectsPort
  state: SampleStatePort
  now?: () => Date
}

export interface CreateSampleInput {
  sampleId: string
  locale: SampleLocale
  /** Exact target folder (must be new and inside the home directory). */
  targetPath?: string
  /** Parent folder for the default `<parent>/<name>[-N]` layout. */
  parentDir?: string
}

export interface CreateSampleResult {
  project: SampleProjectRef
  record: SampleRecord
  /** True when the sample already existed and nothing was written. */
  reused: boolean
}

/** The default parent folder (`~/Specrails Samples`). */
export function defaultSampleParent(files: Pick<SampleFilesPort, 'homeDir' | 'join'>): string {
  return files.join(files.homeDir(), SAMPLE_PARENT_DIR_NAME)
}

/**
 * The recorded sample, or null. A record whose project is no longer registered
 * (removed by hand) is dropped, so the person can create a fresh one.
 */
export function currentSample(deps: Pick<SampleDeps, 'projects' | 'state'>): { record: SampleRecord; project: SampleProjectRef } | null {
  const record = deps.state.read()
  if (!record) return null
  const project = deps.projects.get(record.projectId)
  if (!project) {
    deps.state.clear()
    return null
  }
  return { record, project }
}

function insideHome(deps: SampleDeps, candidate: string): string {
  const home = deps.files.resolve(deps.files.homeDir())
  const resolved = deps.files.resolve(candidate)
  if (!isStrictlyInside(home, resolved, deps.files.sep)) {
    throw new SampleError('outside_home', 'The sample must live inside your home folder', 400)
  }
  return resolved
}

/**
 * Copy the sample into a new folder, make it a git repository with one commit,
 * install its specs and register it as a project. Idempotent: a second call
 * returns the existing sample untouched. Every failure after the folder exists
 * removes what this call created.
 */
export async function createSample(deps: SampleDeps, input: CreateSampleInput): Promise<CreateSampleResult> {
  const sample = deps.samples.find((s) => s.id === input.sampleId)
  if (!sample) throw new SampleError('unknown_sample', `Unknown sample "${input.sampleId}"`, 404)

  const existing = currentSample(deps)
  if (existing) return { project: existing.project, record: existing.record, reused: true }

  let target: string
  if (input.targetPath) {
    target = insideHome(deps, input.targetPath)
    if (deps.files.exists(target)) throw new SampleError('path_exists', 'That folder already exists', 409)
  } else {
    const parent = insideHome(deps, input.parentDir ?? defaultSampleParent(deps.files))
    const name = firstFreeName(sample.name, (candidate) => deps.files.exists(deps.files.join(parent, candidate)))
    if (name === null) throw new SampleError('no_free_name', 'Could not find a free folder name', 409)
    target = deps.files.join(parent, name)
  }

  let registered: SampleProjectRef | null = null
  const rollback = (): void => {
    if (registered) { try { deps.projects.unregister(registered.id) } catch { /* best effort */ } }
    try { deps.files.remove(target) } catch { /* best effort */ }
  }
  try {
    try { deps.files.writeTree(target, sample.files) } catch (err) {
      throw new SampleError('write_failed', `Could not write the sample: ${(err as Error).message}`, 500)
    }
    try { await deps.git.initWithCommit(target, sample.commitMessage) } catch (err) {
      throw new SampleError('git_failed', `git could not create the sample repository: ${(err as Error).message}`, 500)
    }
    const specIds = deps.specs.install(target, sample, input.locale)
    try { registered = deps.projects.register({ path: target, name: sample.name }) } catch (err) {
      throw new SampleError('register_failed', `Could not register the sample project: ${(err as Error).message}`, 500)
    }
    const record: SampleRecord = {
      sampleId: sample.id,
      projectId: registered.id,
      path: target,
      specIds,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
    }
    deps.state.write(record)
    return { project: registered, record, reused: false }
  } catch (err) {
    rollback()
    throw err
  }
}

export interface RemoveSampleResult {
  removedProject: boolean
  deletedFolder: boolean
}

/**
 * Unregister the sample project and, only when asked, delete its folder. The
 * folder is deleted only when it is the exact path recorded at creation, still
 * strictly inside the home directory and still a git repository, so a stale or
 * tampered record can never point the deletion elsewhere.
 */
export function removeSample(deps: SampleDeps, opts: { deleteFolder: boolean }): RemoveSampleResult {
  const record = deps.state.read()
  if (!record) throw new SampleError('not_found', 'There is no sample project', 404)

  let deleteTarget: string | null = null
  if (opts.deleteFolder && deps.files.exists(record.path)) {
    const resolved = insideHome(deps, record.path)
    if (!deps.files.isGitRepo(resolved)) throw new SampleError('unsafe_delete', 'The sample folder is no longer a git repository; it was left in place', 409)
    deleteTarget = resolved
  }

  const removedProject = deps.projects.isRegistered(record.projectId)
  if (removedProject) deps.projects.unregister(record.projectId)
  if (deleteTarget) deps.files.remove(deleteTarget)
  deps.state.clear()
  return { removedProject, deletedFolder: deleteTarget !== null }
}
