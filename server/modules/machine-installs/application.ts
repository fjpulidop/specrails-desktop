/**
 * Machine-wide installs: use cases. Answers a run's install question for Core, running the
 * approved install outside the run, and keeps the person's remembered approvals.
 *
 * - `autoAnswer`: a question the host answers WITHOUT the person. An install already approved
 *   for this exact command runs at once ("ask once": across runs and projects, since the tool is
 *   machine-wide); one the host may never run (it needs a password, or it is not on the
 *   allowlist) is refused so the run stops with the person's step. Anything else asks the person.
 * - `answer`: the person's choice. `install` remembers the approval and runs the command;
 *   `self` declines; any other text reaches Core as it is (only `installed` lets the run go on).
 */
import { INSTALL_ANSWERS, INSTALL_OPTION, installAnswer, installQuestionOf, parseInstallCommand, refusedAnswer, type InstallQuestion } from './domain'

export interface InstallApproval {
  command: string
  manager: string
  tool: string
  approvedAt: string
  lastUsedAt: string | null
  uses: number
}

/** Remembered approvals, machine-wide (the app database). */
export interface InstallApprovalStore {
  get(command: string): InstallApproval | null
  remember(approval: { command: string; manager: string; tool: string }): void
  markUsed(command: string): void
  list(): InstallApproval[]
  /** True when an approval existed. */
  revoke(command: string): boolean
}

export type InstallRunOutcome = { ok: true } | { ok: false; detail: string }

/** Runs one parsed install (argv, no shell) with a time limit, streaming its output lines. */
export interface InstallRunner {
  run(argv: readonly string[], onLine: (line: string) => void): Promise<InstallRunOutcome>
}

export interface MachineInstalls {
  /** The answer the host gives by itself, or null to ask the person. Null for any other interrupt. */
  autoAnswer(interrupt: { kind?: unknown; value?: unknown }, log: (line: string) => void): Promise<string | null>
  /** The answer Core receives for the person's choice (runs the approved install). */
  answer(interrupt: { kind?: unknown; value?: unknown }, choice: string, log: (line: string) => void): Promise<string>
  list(): InstallApproval[]
  revoke(command: string): boolean
}

export function createMachineInstalls(deps: { store: InstallApprovalStore; runner: InstallRunner }): MachineInstalls {
  const { store, runner } = deps

  async function install(question: InstallQuestion, argv: readonly string[], command: string, log: (line: string) => void, remembered: boolean): Promise<string> {
    log(`\n▶ Installing ${question.tool || command} machine-wide${remembered ? ' (approved earlier)' : ''}: ${command}`)
    const outcome = await runner.run(argv, line => log(`  ${line}`))
    store.markUsed(command)
    log(outcome.ok ? `✓ Installed with ${command}. The run continues.` : `✗ ${command} failed: ${outcome.detail}`)
    return installAnswer(outcome)
  }

  return {
    async autoAnswer(interrupt, log) {
      const question = installQuestionOf(interrupt)
      if (!question) return null
      const parsed = parseInstallCommand(question.command)
      if (!parsed.ok) {
        log(`\n■ This run needs ${question.tool || 'a tool'} (\`${question.command}\`). Specrails does not run it for you: ${parsed.detail}.`)
        return refusedAnswer(parsed)
      }
      if (!store.get(parsed.command)) return null
      return install(question, parsed.argv, parsed.command, log, true)
    },
    async answer(interrupt, choice, log) {
      const question = installQuestionOf(interrupt)
      const picked = choice.trim()
      if (!question) return choice
      if (picked === INSTALL_OPTION.self) return INSTALL_ANSWERS.declined
      if (picked !== INSTALL_OPTION.install) return choice
      const parsed = parseInstallCommand(question.command)
      if (!parsed.ok) return refusedAnswer(parsed)
      store.remember({ command: parsed.command, manager: parsed.manager, tool: question.tool || parsed.tool })
      return install(question, parsed.argv, parsed.command, log, false)
    },
    list: () => store.list(),
    revoke: command => store.revoke(command),
  }
}
