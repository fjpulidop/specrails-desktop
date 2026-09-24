import { z } from 'zod'
import { recoveryRequestSchema } from '../../modules/agent-runtime/runtime/agent-runtime-recovery'
import { apiCall, projectPath, type McpToolSpec } from './types'

export function recoveryTools(): McpToolSpec[] {
  return [{
    name: 'specrails_recovery', title: 'Repair a stopped run', hintTier: 'read',
    description: 'Inspect and repair the ORIGINAL saved run worktree without relaunching implementation. Actions: inspect (repositories, registered checks, recent repairs), list_files, read_file (paged lines + SHA-256), diff, history, patch (one exact unique replacement in an existing file, mandatory expectedHash and operationId), check (OpenSpec validation or ONE checkId returned by inspect). Patch requires write permission. Check executes project code and requires destructive permission. No arbitrary shell, checkpoint edits, frozen plan edits, file deletion or automatic resume. Reuse operationId after transport uncertainty; never blindly repeat failed checks. Read history and state a changedPrecondition before repeating a failed check on unchanged code. After successful repair/check use specrails_jobs runtime_resume under its normal authorization and verify the terminal outcome.',
    tier: args => args.action === 'check' ? 'destructive' : args.action === 'patch' ? 'write' : 'read',
    inputSchema: {
      action: z.enum(['inspect', 'list_files', 'read_file', 'diff', 'history', 'patch', 'check']),
      projectId: z.string().optional(), jobId: z.string().min(1),
      repositoryId: z.string().optional().describe('Exact membership returned by inspect; required for file actions'),
      path: z.string().optional().describe('Repository-relative path; list_files accepts .'),
      startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional().describe('history only: nextOffset from the previous page; newest attempts first'),
      expectedHash: z.string().optional().describe('Full-file hash returned by read_file, mandatory for patch'),
      oldText: z.string().optional(), newText: z.string().optional(),
      operationId: z.string().uuid().optional().describe('New UUID per patch/check; reuse with the exact same request after uncertain transport'),
      reason: z.string().optional().describe('Specific diagnosed cause and purpose of the repair/check'),
      kind: z.enum(['openspec', 'verification']).optional(), checkId: z.string().optional(),
      changedPrecondition: z.string().optional().describe('What changed since the failed check; required before repeating an unchanged candidate'),
      acknowledgeInterrupted: z.boolean().optional().describe('Only after inspecting and accepting the partial writes of an interrupted run'),
    },
    async handler(ctx, args) {
      const { projectId, jobId, ...request } = args
      const body = recoveryRequestSchema.parse(request)
      if (typeof jobId !== 'string' || !jobId) throw new Error('Scoped recovery requires jobId')
      return apiCall(ctx, 'POST', `${projectPath(ctx, projectId as string | undefined)}/agent-runtime/runs/${encodeURIComponent(jobId)}/recovery`, body)
    },
  }]
}
