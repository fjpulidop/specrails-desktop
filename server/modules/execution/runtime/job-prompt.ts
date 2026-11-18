// Prompt and system-prompt construction for a queue job spawn (stage of
// QueueManager._startJob). Every function reads its inputs explicitly; the
// ticket store path is passed as a thunk so it is resolved only on the same
// branches (and in the same order) as before the extraction.
import type { WsMessage } from '../../../types'
import type { ProjectExecution } from '../../../workspace-resolution'
import { getProjectSettings, getFreestylePrePrompt, DEFAULT_FREESTYLE_PRE_PROMPT } from '../../../db'
import type { DbInstance } from '../../../db'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from '../../../attachment-manager'
import { extractTicketIdsFromCommand, readStore } from '../../specs/runtime/ticket-store'
import { descriptionWithNonGoals } from '../../specs/domain/non-goals'
import { broadcastSpecAddendaChange, claimSpecAddendaForRun } from '../../specs/runtime/spec-addenda'

export interface JobSystemAppendInput {
  execution: ProjectExecution
  /** Raw job command (the `--yes` probe reads it untrimmed, as before). */
  command: string
  /** Trimmed command used for the implement-command match. */
  commandToRun: string
  /** `resultText` of the job this one depends on, when it has one. */
  parentResultText: string | null | undefined
  spawnInteractive: boolean | undefined
  db: DbInstance | null
  /** Attachment context for implement commands (evaluated only for them). */
  buildAttachmentContext: () => string
}

/**
 * Supplementary context (repository orientation, output chaining, headless
 * mode, local ticket store) that rides `--append-system-prompt`, keeping the
 * user prompt clean.
 */
export function buildJobSystemAppend(input: JobSystemAppendInput): string {
  const { execution, command, commandToRun, spawnInteractive } = input
  let systemAppend = ''

  // Repository orientation (relocated projects only). The rail spawns from the
  // WORKSPACE cwd, which holds only `.specrails/` config — NOT the source code.
  // The repo is reachable via `--add-dir <repoDir>` (injected below) and the
  // `./project` link. The framework templates point at `${SPECRAILS_REPO_DIR:-.}`,
  // but the agent's Read/Grep/Glob/Edit tools do NOT expand that shell-var form
  // (and PowerShell/cmd.exe don't expand POSIX `${VAR:-default}` either) — so on
  // Windows the agent reads a bogus literal path, falls back to the empty
  // workspace cwd, finds only framework files, and hallucinates a wrong/"global"
  // project. Tell it the concrete absolute repo path explicitly. Mirrors the
  // Explore-cwd orientation. Legacy (non-relocated) ⇒ cwd IS the repo ⇒ skipped
  // (byte-identical). The `\${` keeps the shell-var form literal in this string.
  if (execution.relocated && execution.repoDir) {
    systemAppend +=
      `REPOSITORY LOCATION — READ THIS FIRST:\n` +
      `This pipeline runs from a workspace directory that contains ONLY specrails ` +
      `configuration (.specrails/, agent definitions) — NOT your project's source code. ` +
      `Your project's source repository is at this ABSOLUTE path:\n` +
      `  ${execution.repoDir}\n` +
      `It is also exposed to your tools as an additional working directory (via --add-dir) ` +
      `and mounted in this cwd as ./project. Use the absolute repo path above (or ./project) ` +
      `for ALL source reads, edits, greps and globs. Your Read/Grep/Glob/Edit tools do NOT ` +
      `expand shell variables — NEVER pass a literal "\${SPECRAILS_REPO_DIR:-.}" or ` +
      `"\${SPECRAILS_REPO_DIR}" as a path; substitute the absolute path above instead. ` +
      `The spec/ticket store (.specrails/local-tickets.json) lives in THIS workspace cwd. ` +
      `Do NOT look for source files under this cwd — they exist only under the repository ` +
      `path above.\n\n`
  }

  // Output chaining: inject previous step's output as context for dependent jobs
  if (input.parentResultText) {
    const prevOutput = input.parentResultText
    const truncated = prevOutput.length > 10000
      ? prevOutput.slice(0, 10000) + '\n\n[output truncated]'
      : prevOutput
    systemAppend += `Previous step output:\n\n${truncated}\n\n---\n\nNow execute the following command.\n\n`
  }

  // Headless mode: when --yes is in the command, instruct Claude to auto-proceed.
  // For a LEGACY one-shot spawn stdin is genuinely disconnected; for an
  // INTERACTIVE session stdin IS connected (a human may inject guidance), so
  // the wording softens — autonomous by default, steering welcome — without
  // re-opening approval prompts.
  if (command.includes('--yes')) {
    systemAppend += spawnInteractive
      ? '\n\nCRITICAL — AUTONOMOUS MODE WITH LIVE GUIDANCE (--yes flag):\n' +
        'This pipeline runs autonomously end-to-end, but a human operator MAY inject guidance messages while it runs (stdin IS connected).\n' +
        '- NEVER stop to ask for approval, confirmation, review, or feedback. When options exist, choose the RECOMMENDED one and proceed.\n' +
        '- Auto-approve all proposals, designs, and artifacts; skip instructions that say "wait for user" or "present for review".\n' +
        '- If a human message arrives mid-run, treat it as steering: incorporate the guidance and continue the plan without pausing.\n' +
        '- Answer direct questions from the human concisely, then resume the remaining work until the plan is complete.'
      : '\n\nCRITICAL — FULLY AUTONOMOUS MODE (--yes flag):\n' +
        'This pipeline is running headless with NO human operator. stdin is disconnected — nobody can reply.\n' +
        '- NEVER ask for approval, confirmation, review, or feedback. There is nobody to answer.\n' +
        '- NEVER output prompts like "Reply with approved", "Do you want to proceed?", "Please confirm", or "Ready for review".\n' +
        '- NEVER stop between pipeline phases to wait for input. Run ALL phases end-to-end without pausing.\n' +
        '- When there are multiple options or decisions, always choose the RECOMMENDED option and proceed.\n' +
        '- Auto-approve all proposals, designs, and artifacts. Treat everything as "approved" by default.\n' +
        '- Skip any instructions that say "wait for user", "present for review", or "ask the user".\n' +
        '- The pipeline must complete fully from start to finish in a single uninterrupted run.'
  }

  // Local ticket store: implement jobs must read specs from
  // .specrails/local-tickets.json — never from external trackers like Jira/Linear.
  // (`batch-implement` stays matched only for historical/replayed commands.)
  if (/\/(specrails|sr):(implement|batch-implement)\b/.test(commandToRun)) {
    systemAppend += '\n\nIMPORTANT: The ticket/spec data for this project is stored locally in .specrails/local-tickets.json. ' +
      'You MUST read specs from this file. Do NOT attempt to fetch tickets from Jira, Linear, GitHub Issues, or any other external tracker. ' +
      'The #<id> references in the command correspond to ticket IDs inside .specrails/local-tickets.json. ' +
      'Do NOT require jq to inspect this file; on Windows or when jq is unavailable, use PowerShell (`Get-Content .specrails/local-tickets.json -Raw | ConvertFrom-Json`) or Node.js built-ins. ' +
      'When running tests, use the project-defined scripts and package manager commands as-is; do NOT add Jest-only flags such as --runInBand to Vitest commands.'

    const attachmentContext = input.buildAttachmentContext()
    if (attachmentContext) {
      systemAppend += attachmentContext
    }

    const prePrompt = input.db ? getProjectSettings(input.db).prePrompt.trim() : ''
    if (prePrompt) {
      systemAppend += '\n\nPROJECT PRE-PROMPT:\n' +
        'Apply the following project-specific instructions in addition to the ticket/spec and its attached resources.\n\n' +
        prePrompt
    }
  }

  return systemAppend
}

export interface TicketStoreContext {
  /** Project path (`QueueManager._cwd`); every reader is a no-op without it. */
  cwd: string | undefined
  /** Resolves local-tickets.json honouring the relocate-artifacts gate. */
  ticketsPath: () => string
}

export function buildImplementAttachmentContext(
  context: TicketStoreContext & { projectSlug: string | null },
  command: string,
): string {
  if (!context.cwd || !context.projectSlug) return ''
  const projectSlug = context.projectSlug

  const ticketIds = extractTicketIdsFromCommand(command)
  if (ticketIds.length === 0) return ''

  try {
    const store = readStore(context.ticketsPath())
    const sections: string[] = []

    for (const ticketId of ticketIds) {
      const storeAttachmentIds = new Set(
        (store.tickets[String(ticketId)]?.attachments ?? []).map((attachment) => attachment.id),
      )
      const diskAttachmentIds = attachmentManager
        .list(projectSlug, ticketId)
        .map((attachment) => attachment.id)
      const attachmentIds = Array.from(new Set([...storeAttachmentIds, ...diskAttachmentIds]))
      if (attachmentIds.length === 0) continue

      const blocks = attachmentManager.getPromptBlocksSync(projectSlug, ticketId, attachmentIds)
      if (blocks.length === 0) continue

      sections.push(`## Ticket #${ticketId} Attached Resources\n\n${blocks.join('\n\n')}`)
    }

    if (sections.length === 0) return ''

    return '\n\nIMPORTANT: Referenced ticket attachments are also part of the spec context. ' +
      `You have explicit permission to read local attachment files stored under ~/.specrails/projects/${projectSlug}/attachments/<ticketId>/.\n\n` +
      `${USER_ATTACHMENT_SYSTEM_NOTE}\n\n` +
      'If a <user-attachment> block contains only a local file path, open that file directly before implementing.\n\n' +
      sections.join('\n\n')
  } catch (err) {
    console.warn(`[queue-manager] failed to build attachment context: ${(err as Error).message}`)
    return ''
  }
}

/**
 * Spec addenda briefing for a job (spec-addenda): claims (idempotently, keyed
 * on the job id) the open addenda of every ticket the command references and
 * renders the deterministic briefing. Best-effort: an unreadable store ⇒ ''.
 */
export function buildSpecAddendaBriefing(
  context: TicketStoreContext & { projectId: string | null; broadcast: (msg: WsMessage) => void },
  command: string,
  jobId: string,
): string {
  if (!context.cwd) return ''
  const ticketIds = extractTicketIdsFromCommand(command)
  if (ticketIds.length === 0) return ''
  try {
    const claimed = claimSpecAddendaForRun(context.ticketsPath(), ticketIds, jobId)
    if (claimed.store && context.projectId) {
      broadcastSpecAddendaChange((msg) => context.broadcast(msg as unknown as WsMessage), context.projectId, claimed)
    }
    return claimed.briefing
  } catch (err) {
    console.warn(`[queue-manager] failed to build spec addenda briefing: ${(err as Error).message}`)
    return ''
  }
}

/**
 * Build the Claude prompt for an Freestyle job. Freestyle does NOT invoke
 * a slash command: it sends the resolved pre-prompt followed by the full spec
 * text of every ticket referenced in the command. Fully reconstructible from
 * the command (`/specrails:freestyle #<id> …`) + the local ticket store, so a
 * queued job survives a server restart without losing the prompt.
 */
export function buildFreestylePrompt(
  context: TicketStoreContext & { db: DbInstance | null },
  command: string,
): string {
  const pre = context.db ? getFreestylePrePrompt(context.db) : DEFAULT_FREESTYLE_PRE_PROMPT
  const ticketIds = extractTicketIdsFromCommand(command)
  const specs: string[] = []
  if (context.cwd) {
    try {
      const store = readStore(context.ticketsPath())
      for (const ticketId of ticketIds) {
        const ticket = store.tickets[String(ticketId)]
        if (!ticket) continue
        const body = descriptionWithNonGoals(ticket.description, ticket.nonGoals).trim()
        specs.push(`# Spec #${ticketId}: ${ticket.title}\n\n${body || '_(no description)_'}`)
      }
    } catch (err) {
      console.warn(`[queue-manager] failed to read specs for freestyle: ${(err as Error).message}`)
    }
  }
  const specBlock = specs.length > 0
    ? specs.join('\n\n---\n\n')
    : `(No spec content found for ${ticketIds.map((id) => `#${id}`).join(', ') || 'this rail'}.)`
  return `${pre}\n\n---\n\n${specBlock}`
}
