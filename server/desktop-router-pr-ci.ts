/**
 * App-level "Run on a PR" for the built-in Fix PR CI loop (`POST /api/pr-ci/runs`).
 * Loops is a cross-project library, so the pull request's repository picks the
 * project; the run itself is the project's mission-origin PR CI admission
 * (`modules/delivery/runtime/pr-ci`), shown in a mission of that project.
 */
import type { Router, Request, Response } from 'express'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import { prCiAdmissionRuntimeOf } from './modules/delivery/runtime/pr-ci/pr-ci-admission-runtime'
import { getPrCiAdmissionByTarget } from './modules/delivery/runtime/pr-ci/pr-ci-admission'
import { runPrCiOnPr } from './modules/delivery/runtime/pr-ci/pr-ci-on-demand'
import { defaultExec } from './modules/delivery/runtime/pr-publisher'
import { createAgentConversation, getAgentConversation, updateAgentConversation } from './modules/agents/runtime/agent-store'
import { getAgentChatManager } from './modules/missions/runtime/agent-chat-registry'
import { defaultMachineProvider } from './provider-selection'

export function registerPrCiRunRoutes(router: Router, deps: { registry: ProjectRegistry }): void {
  const { registry } = deps
  router.post('/pr-ci/runs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.prUrl !== 'string' || !body.prUrl.trim() || body.prUrl.length > 512) {
      res.status(400).json({ error: 'pr_url_invalid', detail: 'Provide the full pull request URL.' }); return
    }
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null
    try {
      await registry.whenWarm()
      const result = await runPrCiOnPr<ProjectContext>({
        exec: defaultExec,
        contexts: () => registry.listContexts(),
        runtimeOf: context => prCiAdmissionRuntimeOf(context),
        missionFor: (context, target, parsed) => {
          const db = registry.desktopDb
          const previous = getPrCiAdmissionByTarget(context.db, context.project.id, target.repositoryId, target.prNumber)?.origin_conversation_id
          const alive = previous ? getAgentConversation(db, previous) : undefined
          if (alive && !alive.deleted_at) return alive.id
          const created = createAgentConversation(db, { provider: defaultMachineProvider(), pinnedProjectId: context.project.id })
          updateAgentConversation(db, created.id, { title: `CI · ${parsed.slug}#${parsed.prNumber}` })
          getAgentChatManager()?.notifyConversationCreated(created.id)
          return created.id
        },
      }, { prUrl: body.prUrl, projectId })
      const { ok: _ok, status, ...payload } = result
      res.status(status).json(payload)
    } catch (error) {
      res.status(500).json({ error: 'pr_ci_run_failed', detail: error instanceof Error ? error.message : 'Could not start the repair.' })
    }
  })
}
