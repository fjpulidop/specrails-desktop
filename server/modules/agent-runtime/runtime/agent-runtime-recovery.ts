import { execFile, type ChildProcess } from 'node:child_process'
import { z } from 'zod'
import { resolveRetainedAgentRuntime } from './agent-runtime-package'
import { resolveCoreNodeRuntime } from '../../../core-node-runtime'
import { windowsSpawnEnv } from '../../../util/win-spawn'

// Desktop validates its HTTP contract; retained Core independently validates
// the same operation at the filesystem/lease boundary.
const file = { repositoryId: z.string().min(1).max(128), path: z.string().min(1).max(1024) }
const operation = { operationId: z.string().uuid(), reason: z.string().trim().min(1).max(2000), acknowledgeInterrupted: z.boolean().optional(), changedPrecondition: z.string().trim().min(1).max(2000).optional() }
export const recoveryRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect') }).strict(),
  z.object({ action: z.literal('history'), offset: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('list_files'), ...file }).strict(),
  z.object({ action: z.literal('read_file'), ...file, startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('diff'), ...file }).strict(),
  z.object({ action: z.literal('patch'), ...file, ...operation, expectedHash: z.string().regex(/^[a-f0-9]{64}$/), oldText: z.string().min(1).max(16_384), newText: z.string().max(16_384) }).strict(),
  z.object({ action: z.literal('check'), ...operation, kind: z.enum(['openspec', 'verification']), checkId: z.string().min(1).max(256).optional() }).strict(),
])
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>

export async function invokeRuntimeRecovery(input: { contextPath: string; cwd: string; env: NodeJS.ProcessEnv; request: RecoveryRequest; onSpawn?: (child: ChildProcess) => void }): Promise<unknown> {
  const cli = resolveRetainedAgentRuntime(input.contextPath)
  const invoke = (args: string[], stdin?: string): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile(resolveCoreNodeRuntime(), [cli, ...args], {
      cwd: input.cwd, env: windowsSpawnEnv(input.env), windowsHide: true,
      timeout: stdin ? 65_000 : 15_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (!error) { resolve(stdout); return }
      let detail = 'Recovery did not complete; inspect its history before retrying with the same operationId.'
      try { const parsed = JSON.parse(stdout); if (typeof parsed.error === 'string') detail = parsed.error.slice(-6000) } catch { /* Do not misrepresent an uncertain transport outcome. */ }
      reject(new Error(detail))
    })
    input.onSpawn?.(child)
    child.stdin?.end(stdin ?? '')
  })
  const api = JSON.parse(await invoke(['api'])) as { capabilities?: { scopedRecovery?: number } }
  if (api.capabilities?.scopedRecovery !== 1) throw new Error('The retained original Core does not support scoped recovery. Preserve this run; use a manual repair in its original worktree. Do not replace its runtime or relaunch to bypass this limit.')
  const response = JSON.parse(await invoke(['recovery', '--context', input.contextPath, '--stdin'], JSON.stringify(input.request)))
  if (response.type !== 'runtime-recovery' || response.schemaVersion !== 1 || !('result' in response)) throw new Error('Invalid Core recovery response; inspect recovery history before retrying')
  return response.result
}
