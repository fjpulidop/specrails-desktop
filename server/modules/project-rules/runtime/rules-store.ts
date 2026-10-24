/**
 * Effectful half of the project rules inventory (task 4.4): locate and read
 * `.specrails/rules.json`, and re-run Core's inventory command.
 *
 * The file lives in the project's `.specrails/` directory, which is the
 * relocated workspace for a relocated project and the repository otherwise;
 * both are checked, workspace first. Every read is bounded and tolerant.
 */
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { resolveCoreRuntime } from '../../../core-runtime'
import { resolveBundledNodeExe } from '../../../path-resolver'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { parseRulesInventory, RULES_FILE, type ProjectRulesInventory } from '../domain'

const FILE_CAP = 2 * 1024 * 1024
export const RULES_INVENTORY_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Core CLI arguments of the re-runnable inventory step (contract 5.7
 * `agentRuntime.rulesInventory.cli`: `specrails-core rules inventory --root
 * <repo> [--artifact-root <dir>]`; exits 0 and always writes the file).
 * Desktop only runs it when Core announces `rulesInventory: 1`.
 */
export const RULES_INVENTORY_ARGS = ['rules', 'inventory'] as const

export interface RulesProject { slug: string; path: string }

/** The directory that holds `.specrails/agent-runtime.json` (Core's artifact root). */
export function rulesArtifactRoot(project: RulesProject): string {
  try {
    const execution = resolveProjectExecution({ slug: project.slug, path: project.path })
    if (execution.specrailsDir) return path.dirname(execution.specrailsDir)
  } catch { /* fall back to the repository */ }
  return project.path
}

/** Candidate locations: `<artifactRoot>/.specrails/rules.json` (where Core writes
 *  it), then the repository's `.specrails/rules.json`. */
export function rulesFileCandidates(project: RulesProject): string[] {
  const candidates: string[] = [path.join(rulesArtifactRoot(project), '.specrails', RULES_FILE)]
  candidates.push(path.join(project.path, '.specrails', RULES_FILE))
  return [...new Set(candidates)]
}

export type RulesReadResult =
  | { state: 'missing' }
  | { state: 'invalid'; file: string; message: string }
  | { state: 'ok'; file: string; inventory: ProjectRulesInventory; modifiedAt: string | null }

export function readProjectRules(project: RulesProject): RulesReadResult {
  for (const file of rulesFileCandidates(project)) {
    let raw: string
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > FILE_CAP) return { state: 'invalid', file, message: 'rules.json is larger than 2 MB' }
      raw = fs.readFileSync(file, 'utf8')
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { return { state: 'invalid', file, message: 'rules.json is not valid JSON' } }
      const inventory = parseRulesInventory(parsed)
      if (!inventory) return { state: 'invalid', file, message: 'rules.json does not match the rules inventory format' }
      return { state: 'ok', file, inventory, modifiedAt: stat.mtime.toISOString() }
    } catch {
      continue
    }
  }
  return { state: 'missing' }
}

/** The inventory or null (absent/invalid) — for packet harvest and suggestions. */
export function readProjectRulesInventory(project: RulesProject): ProjectRulesInventory | null {
  const result = readProjectRules(project)
  return result.state === 'ok' ? result.inventory : null
}

export interface RulesInventoryRunResult { ok: boolean; exitCode: number | null; output: string }

/** Injectable process seam (tests replace it). */
export type RulesInventoryRunner = (file: string, args: string[], options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }) => Promise<RulesInventoryRunResult>

const defaultRunner: RulesInventoryRunner = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const output = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(-4000)
    const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : error ? null : 0
    resolve({ ok: !error, exitCode: code, output })
  })
})

/** Re-run Core's inventory for the project. Never throws. */
export async function runRulesInventory(project: RulesProject, runner: RulesInventoryRunner = defaultRunner): Promise<RulesInventoryRunResult> {
  let cli: string | null = null
  try { cli = resolveCoreRuntime()?.cli ?? null } catch (error) {
    return { ok: false, exitCode: null, output: error instanceof Error ? error.message : 'Core is unavailable' }
  }
  if (!cli) return { ok: false, exitCode: null, output: 'Core is unavailable' }
  // In the packaged app process.execPath is the server binary, not node.
  const node = resolveBundledNodeExe() ?? process.execPath
  const artifactRoot = rulesArtifactRoot(project)
  const args = [cli, ...RULES_INVENTORY_ARGS, '--root', project.path, ...(path.resolve(artifactRoot) !== path.resolve(project.path) ? ['--artifact-root', artifactRoot] : [])]
  return runner(node, args, { cwd: project.path, timeout: RULES_INVENTORY_TIMEOUT_MS, env: process.env })
}
