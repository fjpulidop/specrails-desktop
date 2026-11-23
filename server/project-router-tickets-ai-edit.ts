// AI description editing (POST/DELETE /tickets/:id/ai-edit): spawns the
// provider CLI with the project agent environment, streams ticket_ai_edit_*
// WebSocket events, records the invocation and lets the client cancel a
// running edit. The live-process map is owned per registration (per router).

import type { Request, Response } from 'express'
import { newId as uuidv4 } from './ids'
import { getAdapter } from './providers'
import { recordInvocation } from './modules/accounting/runtime/ai-invocations'
import { finaliseInvocationResult } from './modules/accounting/runtime/result-event'
import type { AdapterEvent, SpawnOptions } from './providers/types'
import { buildProviderEnv, parseStreamEvents, providerEnvAllowlist, supportsToolPolicy } from './providers/runtime'
import { projectAgentSourceEnv } from './project-env'
import { randomUUID } from 'crypto'
import { getModelsForProvider, isValidModelForProvider, type SpecProvider } from './modules/specs/runtime/spec-models'
import { validateRequestedProvider } from './provider-selection'
import type { TicketAiEditStreamMessage, TicketAiEditDoneMessage, TicketAiEditErrorMessage } from './types'
import { spawnAiCli } from './util/cli-prompt'
import { trackTransientChild } from './transient-children'
import { captureProcessAdmission } from './process-admission'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import { requireTicketIdParam } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketAiEditRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps

  // POST /:projectId/tickets/:id/ai-edit — AI-powered description editing
  const _aiEditProcesses = new Map<string, import('child_process').ChildProcess>()

  router.post('/:projectId/tickets/:id/ai-edit', async (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    const instructions = req.body?.instructions as string | undefined
    const currentDescription = req.body?.description as string | undefined
    const currentTitle = typeof req.body?.title === 'string' ? (req.body.title as string) : ''
    if (!instructions?.trim()) {
      res.status(400).json({ error: 'instructions is required' }); return
    }
    if (!currentDescription) {
      res.status(400).json({ error: 'description is required' }); return
    }
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? (req.body.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const priorInstructions = Array.isArray(req.body?.priorInstructions)
      ? (req.body.priorInstructions as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const priorProposalRaw = req.body?.priorProposal
    const priorProposal = typeof priorProposalRaw === 'string' && priorProposalRaw.length > 0 ? priorProposalRaw : null
    const isRefinement = priorProposal !== null

    const { project, broadcast } = ctx(req)
    const providerCheck = validateRequestedProvider(
      project,
      req.body?.provider ?? req.body?.aiEngine,
    )
    if (!providerCheck.ok) {
      res.status(400).json({ error: providerCheck.error }); return
    }
    const provider = providerCheck.provider
    const adapter = getAdapter(provider)
    if (!supportsToolPolicy(adapter, 'read-only')) {
      res.status(409).json({
        error: 'provider_tool_policy_unsupported',
        provider,
        requiredPolicy: 'read-only',
      })
      return
    }
    const requestId = uuidv4()
    const projectId = project.id
    const admission = captureProcessAdmission(projectId)
    const requestedAiEditModel =
      typeof req.body?.model === 'string' ? req.body.model : adapter.defaultModel()
    if (!isValidModelForProvider(requestedAiEditModel, provider as SpecProvider)) {
      res.status(400).json({
        error: `model is not valid for provider "${provider}"`,
        allowed: getModelsForProvider(provider as SpecProvider),
      }); return
    }
    const aiEditModel = requestedAiEditModel

    // Build the focused pre-prompt
    const baseRules =
      `- Output format MUST be exactly:\n` +
      `    TITLE: <one-line spec title>\n` +
      `    SHORT-SUMMARY: <one or two plain-language sentences, max 120 chars, summarising the spec for a dashboard postit. No markdown, no bullets.>\n` +
      `    \n` +
      `    <markdown description body>\n` +
      `  The first line MUST start with "TITLE: " followed by the refined title.\n` +
      `  The second line MUST start with "SHORT-SUMMARY: " followed by the summary.\n` +
      `  Then exactly one blank line. Then the markdown description.\n` +
      `- Keep the title concise (under 80 characters) and reflective of the latest description.\n` +
      `  If the user's refinement does not affect the title's intent, you may keep it unchanged — but always emit the TITLE line.\n` +
      `- The SHORT-SUMMARY line MUST always be present. If the user's refinement does not change what the spec is about, keep the previous summary verbatim. Never omit the line.\n` +
      `- After the SHORT-SUMMARY line and blank line, output ONLY the modified description in markdown. No preamble, no explanation, no wrapping.\n` +
      `- Preserve the existing markdown structure and section headings in the description.\n` +
      `- If the user asks to add technical details, briefly check CLAUDE.md and the project directory structure with Read, Grep, or Glob (not deep reads) to ground your edits.\n` +
      `- Keep it concise and actionable.\n` +
      `- Do NOT create files, tickets, or issues. Only output text.`

    const refinementRule = isRefinement
      ? `\n- You are editing an in-progress draft, not the saved description. Apply the new refinement to the Latest Draft below.`
      : ''

    let systemPrompt =
      `You are a spec editor. You will receive a ticket title and description plus user instructions for how to modify them. ` +
      `Your job is to produce an improved version of BOTH the title and the description.\n\n` +
      `RULES:\n` +
      `${baseRules}${refinementRule}`

    let userPrompt = isRefinement
      ? `## Current Title (saved baseline)\n\n${currentTitle}\n\n` +
        `## Current Description (saved baseline — do not rewrite)\n\n${currentDescription}\n\n` +
        `## Prior Refinement Turns\n\n${priorInstructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
        `## Latest Draft (from previous turn — apply the new refinement to this; the draft already includes a TITLE: line)\n\n${priorProposal}\n\n` +
        `## New Refinement\n\n${instructions.trim()}\n\n` +
        `Output the updated TITLE line followed by the updated description now.`
      : `## Current Title\n\n${currentTitle}\n\n` +
        `## Current Description\n\n${currentDescription}\n\n` +
        `## User Instructions\n\n${instructions.trim()}\n\n` +
        `Output the modified TITLE line followed by the modified description now.`

    let imageFlags: string[] = []
    let aiEditImagePaths: string[] = []
    if (attachmentIds.length > 0) {
      try {
        const extracted = await attachmentManager.getClaudeArgs(project.slug, ticketId, attachmentIds)
        imageFlags = extracted.imageFlags
        aiEditImagePaths = extracted.imagePaths
        if (extracted.textBlocks.length > 0) {
          systemPrompt = `${systemPrompt}\n\n${USER_ATTACHMENT_SYSTEM_NOTE}`
          userPrompt = `${userPrompt}\n\n## Attached Files\n\n${extracted.textBlocks.join('\n\n')}`
        }
      } catch (err) {
        console.error('[project-router] ai-edit attachment extraction error:', err)
      }
    }

    if (!admission.isCurrent()) {
      res.status(409).json({ error: 'Project is being removed' })
      return
    }

    const binary = adapter.binary
    const aiEditOptions: SpawnOptions = {
      prompt: userPrompt,
      systemPrompt,
      model: aiEditModel,
      toolPolicy: 'read-only',
      maxTurns: 4,
      extraArgs: provider === 'claude' ? imageFlags : undefined,
      imagePaths: adapter.capabilities.supportsImageInput ? aiEditImagePaths : undefined,
    }
    const args = adapter.buildArgs('agent-refine', aiEditOptions)

    // spawnAiCli reroutes multi-line argv values through stdin on Windows.
    console.log(`[project-router] ai-edit spawn: ${binary} (cwd=${project.path}, requestId=${requestId})`)
    const child = spawnAiCli(binary, args, {
      env: buildProviderEnv(adapter, aiEditOptions, projectAgentSourceEnv(ctx(req).db, providerEnvAllowlist(adapter))),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: project.path,
    })
    trackTransientChild(projectId, child)

    _aiEditProcesses.set(requestId, child)

    // Pipe stderr to server log so failures surface for debugging.
    let aiEditStderrBuf = ''
    /* c8 ignore start -- diagnostic-only; fires only when claude writes stderr */
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      aiEditStderrBuf += s
      console.error(`[project-router] ai-edit stderr (${requestId}): ${s.trimEnd()}`)
    })
    /* c8 ignore stop */

    // Without this listener, ENOENT (binary missing on PATH) propagates as
    // an unhandled 'error' event and crashes the entire app process.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[project-router] ai-edit spawn failed (${binary}): ${err.message}`)
      _aiEditProcesses.delete(requestId)
      if (!admission.isCurrent()) return
      const errMsg: TicketAiEditErrorMessage = {
        type: 'ticket_ai_edit_error', projectId, ticketId: Number(ticketId),
        requestId, error: `Failed to launch ${binary}: ${err.message}`,
        timestamp: new Date().toISOString(),
      }
      broadcast(errMsg)
    })
    /* c8 ignore stop */

    res.status(202).json({ requestId })

    let buffer = ''
    // Accumulate provider-agnostic adapter events (usage/cost/model) alongside
    // the hand-parsed text buffer so the close handler can record an
    // ai_invocations row for this billable run (HIGH-4). Parsing is pure, so a
    // per-line parse here is independent of the provider-specific text handling
    // below.
    const adapterEvents: AdapterEvent[] = []
    const aiEditStartedAt = new Date().toISOString()
    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      const eventsForLine = parseStreamEvents(adapter, line)
      adapterEvents.push(...eventsForLine)
      for (const event of eventsForLine) {
        if (event.kind === 'text-delta' && event.text) {
          buffer += event.text
          const msg: TicketAiEditStreamMessage = {
            type: 'ticket_ai_edit_stream', projectId, ticketId: Number(ticketId),
            requestId, delta: event.text, timestamp: new Date().toISOString(),
          }
          broadcast(msg)
        }
      }
    })

    child.on('close', (code) => {
      _aiEditProcesses.delete(requestId)
      if (!admission.isCurrent()) return
      const delivered = code === 0 && buffer.trim().length > 0
      if (delivered) {
        const msg: TicketAiEditDoneMessage = {
          type: 'ticket_ai_edit_done', projectId, ticketId: Number(ticketId),
          requestId, fullText: buffer.trim(), timestamp: new Date().toISOString(),
        }
        broadcast(msg)
      } else {
        const reason = code === 0 ? 'Empty response from AI' : `Process exited with code ${code}`
        console.error(
          `[project-router] ai-edit failed (${requestId}): ${reason}` +
            (aiEditStderrBuf.trim() ? `\n  stderr: ${aiEditStderrBuf.trim()}` : '') +
            (buffer.trim() ? `\n  stdout-buffer: ${buffer.trim().slice(0, 500)}` : ''),
        )
        const msg: TicketAiEditErrorMessage = {
          type: 'ticket_ai_edit_error', projectId, ticketId: Number(ticketId),
          requestId, error: reason,
          timestamp: new Date().toISOString(),
        }
        broadcast(msg)
      }

      // ai_invocations capture (surface='ai-edit'). One row per ticket AI-Edit
      // run — this is a billable multi-turn agentic claude/codex run that was
      // previously invisible to spending (HIGH-4). finaliseInvocationResult
      // yields native cost when present, else a pricing-table estimate over the
      // captured token usage (estimated=true) — including runs killed before a
      // result event.
      try {
        const { result: normalised, estimated } = finaliseInvocationResult(
          adapter,
          adapterEvents,
          { fallbackModel: aiEditModel },
        )
        recordInvocation(ctx(req).db, {
          id: randomUUID(),
          project_id: projectId,
          provider: adapter.id,
          surface: 'ai-edit',
          surface_ref_id: requestId,
          ticket_id: Number(ticketId),
          status: delivered ? 'success' : 'failed',
          started_at: aiEditStartedAt,
          finished_at: new Date().toISOString(),
          total_cost_usd_estimated: estimated,
          ...normalised,
        })
        broadcast({ type: 'spending.invalidated', projectId })
      } catch (err) {
        console.error('[project-router] ai-edit recordInvocation failed:', err)
      }
    })
  })

  router.delete('/:projectId/tickets/:id/ai-edit', (req: Request, res: Response) => {
    const requestId = req.query.requestId as string | undefined
    if (!requestId) { res.status(400).json({ error: 'requestId query param required' }); return }
    const child = _aiEditProcesses.get(requestId)
    if (!child?.pid) { res.status(404).json({ error: 'No active AI edit for this request' }); return }
    treeKill(child.pid, 'SIGTERM')
    _aiEditProcesses.delete(requestId)
    res.json({ ok: true })
  })
}
