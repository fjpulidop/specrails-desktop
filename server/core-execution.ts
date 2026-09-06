import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { LoopSpec } from './loop-graph'
import type { RunExecutionManifest } from './multi-repo-execution-store'
import { resolveBundledNodeExe } from './path-resolver'
import { assertWorkspaceCoreReady } from './core-update-state'

export interface CoreRunInput {
  runId: string
  repositoryId?: string
  spec?: LoopSpec
  verificationStep?: boolean
  goal?: string
}

interface CoreContext {
  schemaVersion: 1
  runId: string
  backlogRoot: string
  backlogPath: string
  artifactRoot: string
  artifactRepositoryId: string
  repositories: Array<{ id: string; name: string; path: string; baseSha?: string }>
  ownership: { git: 'host' | 'core'; backlog: 'host'; worktrees: 'host' }
  specs: Array<{ id: string | number; title: string; description: string; repositoryIds?: string[] }>
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// Resolve existing ancestors too: the tickets file may not exist yet, and macOS
// exposes temporary directories through both /var and /private/var.
function canonicalPath(path: string): string {
  try { return realpathSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalPath(parent), basename(path))
  }
}

/** Stable run identity and frozen inputs are shared by every provider and retry.
 * No cwd/global singleton: two rails in the same workspace get separate files.
 */
export function prepareCoreExecution(input: {
  run: CoreRunInput; cwd: string; repoDir?: string; manifest?: RunExecutionManifest; env: NodeJS.ProcessEnv
}): { env: NodeJS.ProcessEnv; promptPrefix: string; contextPath: string } {
  const { run, manifest } = input
  if (!SAFE_ID.test(run.runId)) throw new Error('Invalid Core execution run id')
  const cwd = realpathSync(input.cwd)
  assertWorkspaceCoreReady(cwd)
  const repositories = manifest
    ? manifest.repositories.map(repo => ({ id: repo.repositoryId, name: repo.name, path: realpathSync(repo.worktreePath), baseSha: repo.baseSha }))
    : [{ id: run.repositoryId ?? (run.spec?.repositoryIds?.length === 1 ? run.spec.repositoryIds[0]! : 'primary'), name: basename(input.repoDir ?? cwd), path: realpathSync(input.repoDir ?? cwd) }]
  if (!repositories.length || repositories.some(repo => !SAFE_ID.test(repo.id))) throw new Error('Invalid Core repository scope')
  const artifactRepositoryId = manifest?.artifactRepositoryId ?? repositories[0]!.id
  const artifactRepo = repositories.find(repo => repo.id === artifactRepositoryId)
  if (!artifactRepo) throw new Error('Core artifact repository is outside the run scope')
  const rawTickets: Array<{ id: string | number; title?: string; description?: string; repositoryIds?: string[] }> = run.spec?.tickets?.length ? run.spec.tickets : run.spec ? [{
    id: run.spec.id ?? run.spec.ticketIds?.[0] ?? 'goal', title: run.spec.title,
    description: run.spec.description, repositoryIds: run.spec.repositoryIds,
  }] : run.goal ? [{ id: 'goal', title: 'Loop goal', description: run.goal }] : []
  const specs = rawTickets.map(ticket => ({
    id: ticket.id, title: ticket.title ?? '', description: ticket.description ?? '',
    ...(ticket.repositoryIds ? { repositoryIds: [...ticket.repositoryIds] } : {}),
  }))
  if (specs.some(spec => spec.repositoryIds?.some(id => !repositories.some(repo => repo.id === id)))) {
    throw new Error('Frozen spec selects a repository outside the execution scope')
  }
  const backlogPath = canonicalPath(input.env.SPECRAILS_TICKETS_PATH
    ? resolve(input.env.SPECRAILS_TICKETS_PATH) : join(cwd, '.specrails', 'local-tickets.json'))
  const backlogRoot = realpathSync(dirname(dirname(backlogPath)))
  const context: CoreContext = {
    schemaVersion: 1, runId: run.runId, backlogRoot,
    backlogPath, artifactRoot: artifactRepo.path,
    artifactRepositoryId, repositories,
    ownership: { git: input.env.SPECRAILS_GIT_AUTO === 'false' ? 'host' : 'core', backlog: 'host', worktrees: 'host' }, specs,
  }
  const directory = join(backlogRoot, '.specrails', 'pipeline', run.runId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Core owns context.json and may normalize/add fields there. Keep Desktop's
  // immutable admission snapshot separate so the next rail step can reuse it.
  const contextPath = join(directory, 'desktop-context.json')
  const serialized = JSON.stringify(context, null, 2) + '\n'
  try { writeFileSync(contextPath, serialized, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (readFileSync(contextPath, 'utf8') !== serialized) throw new Error('Core execution context changed during an active run; start a new run for changed scope')
  }
  const env = { ...input.env, SPECRAILS_EXECUTION_CONTEXT: contextPath }
  const promptPrefix = run.verificationStep ? coreVerificationContext(contextPath, cwd, env, run.runId) : ''
  return { env, contextPath, promptPrefix }
}

/** Ask the installed Core runtime to validate its own receipts. Desktop never
 * treats an agent-authored summary or a JSON 'pass' field as verification.
 * Missing/old runtimes simply leave the normal verification path enabled.
 */
export function coreVerificationContext(contextPath: string, cwd: string, env: NodeJS.ProcessEnv, runId: string): string {
  const helper = join(cwd, '.specrails', 'runtime', 'pipeline.mjs')
  if (!existsSync(helper)) return ''
  try {
    const stdout = execFileSync(resolveBundledNodeExe() ?? process.execPath, [helper, 'status', '--context', contextPath], {
      cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const status = JSON.parse(stdout) as {
      schemaVersion?: number; runId?: string; phases?: { reviewer?: { status?: string } }
      verification?: { valid?: boolean; reasons?: string[]; receipt?: { id?: string; kind?: string; commands?: Array<{ repositoryId: string; command: string; args: string[]; cwd: string; exitCode: number }> } }
    }
    if (status.schemaVersion !== 1 || status.runId !== runId || status.verification?.valid !== true
      || status.verification.receipt?.kind !== 'full' || status.phases?.reviewer?.status !== 'done') return ''
    const commands = status.verification.receipt.commands
    if (!commands?.length || commands.some(command => command.exitCode !== 0)) return ''
    return [
      'Core verified evidence for this exact run (validated by its installed runtime at step start):',
      JSON.stringify({ receiptId: status.verification.receipt.id, commands: commands.map(({ repositoryId, command, args, cwd }) => ({ repositoryId, command, args, cwd })) }),
      'You may reuse these successful commands while inspecting every acceptance criterion and cross-repository contract. Before reporting PASS, validate again with the installed pipeline runtime status using SPECRAILS_EXECUTION_CONTEXT. If you edit files, change configuration/environment, need uncovered behavioral checks, or the receipt is no longer valid, run the affected checks and refresh the full receipt. Do not repeat an unchanged complete verification merely because a new loop step started.',
    ].join('\n')
  } catch { return '' }
}
