import type { ChildProcess } from 'node:child_process'
import type { AiStepResult, LoopRunRequest } from './loop-run-manager'

/** Core `HostBlocker`: structured precondition the host must act on (environment repair refused, setup failed, fixer-declared). */
export interface DefinitionHostBlocker {
  kind: 'network' | 'credential' | 'environment-variable' | 'toolchain' | 'setup' | 'environment' | 'scope'
  reason: string
  command: string
  args: string[]
  cwd: string
  requiredAction: string
  evidenceId?: string
}
export interface DefinitionCompletion {
  ok: boolean
  verified: boolean
  reasons: string[]
  /** Present when the run ended through an `end` node with `blockerFrom`; absent on older Core and on ordinary ends. */
  blocker?: DefinitionHostBlocker
}
export interface DefinitionInterrupt {
  id: string
  nodePath: string
  scopeId?: string
  kind: 'question' | 'approval' | 'gate' | 'host-task'
  attemptId?: string
  value?: unknown
}
/** Core `HostTaskInterrupt` payload (contract 5.11, capability `hostTasks`): a MACHINE interrupt. */
export interface DefinitionHostTaskRequest {
  kind: 'host-task'
  task: string
  input: Record<string, unknown>
  outcomes: string[]
  effect: 'read' | 'write'
  timeoutMs?: number
  candidate: { hash: string | null; verified: boolean; receiptId?: string }
  nodePath: string
}
/** The host's typed answer, written to `--host-result`. */
export interface DefinitionHostTaskResult { outcome: string; output?: unknown }
export function isHostTaskInterrupt(item: DefinitionInterrupt): item is DefinitionInterrupt & { kind: 'host-task'; value: DefinitionHostTaskRequest } {
  const value = item.value as Partial<DefinitionHostTaskRequest> | undefined
  return item.kind === 'host-task' && !!value && typeof value.task === 'string' && Array.isArray(value.outcomes)
}
/** Core `state.pause`: a host `runtime pause` parked the run at a step boundary (no interrupt). */
export interface DefinitionHostPause { requestId: string; reason: string; at: string }
export interface DefinitionRuntimeResult extends AiStepResult {
  runtimeStatus: 'succeeded' | 'paused' | 'failed' | 'blocked' | 'cancelled'
  completion?: DefinitionCompletion
  pendingInterrupts?: DefinitionInterrupt[]
  pendingQuestion?: { stepId?: string; question?: string }
  pendingApproval?: { stepId?: string; reason?: string }
  pause?: DefinitionHostPause
  graph?: Record<string, unknown>
}
export interface DefinitionPrepared {
  contextPath: string
  runtimeDirectory: string
  definitionPath: string
  configPath: string
  definitionHash: string
  definition: Record<string, unknown>
  context: Record<string, unknown>
  runtimeIdentity?: Record<string, unknown>
}
export interface DefinitionResumeControls { answer?: string; approve?: string[]; interruptId?: string; recover?: string[]; hostResult?: DefinitionHostTaskResult }
export interface DefinitionLoopInvocation {
  contextPath?: string
  recover?: string[]
  onPrepared?(metadata: DefinitionPrepared): void
  request: LoopRunRequest
  runId: string
  resume?: boolean
  answer?: string
  approve?: string[]
  interruptId?: string
  /** Resolution of one pending `host-task` interrupt (`--host-result`, with `interruptId`). */
  hostResult?: DefinitionHostTaskResult
  onLine(line: string, source?: 'stdout' | 'stderr', metadata?: { attemptId?: string }): void
  onRuntimeEvent(event: Record<string, unknown>): void
  onSpawn(child: ChildProcess): void
  timeoutMs?: number
}

export interface DefinitionLoopExecutionPorts {
  continuation?: DefinitionResumeControls & {resume: true}
  contextPath?(): string | undefined
  invoke(input: DefinitionLoopInvocation): Promise<DefinitionRuntimeResult>
  isCancelled(): boolean
  remainingMs(): number | undefined
  onLine(line: string, source?: 'stdout' | 'stderr', metadata?: { attemptId?: string }): void
  onRuntimeEvent(event: Record<string, unknown>): void
  onSpawn(child: ChildProcess): void
  onPrepared?(metadata: DefinitionPrepared): void
  onInvocationEnd(result: DefinitionRuntimeResult): void
  /**
   * Resolve a machine interrupt without a person (capability `hostTasks`).
   * Absent ⇒ the host cannot serve host tasks and the run is stopped.
   */
  resolveHostTask?(interrupt: DefinitionInterrupt & { value: DefinitionHostTaskRequest }): Promise<{ action: 'stop' } | { action: 'resume'; result: DefinitionHostTaskResult }>
  awaitHumanDecision(reason: string, pending: DefinitionInterrupt[]): Promise<{ action: 'stop' } | { action: 'resume'; text: string; interruptId?: string; approve?: boolean }>
  /** Host gate before re-invoking Core with a human decision (daily budget).
   *  'stop' settles the run as cancelled exactly like a Stop while paused. */
  beforeContinuation?(): Promise<'continue' | 'stop'>
  /** Host-requested pause (`state.pause`, no interrupt), e.g. the daily budget.
   *  'continue' resumes the retained run as is; 'stop' settles it cancelled. */
  awaitHostPause?(pause: DefinitionHostPause): Promise<'continue' | 'stop'>
}

/** One retained Core process at a time; all graph scheduling remains in Core. */
export async function runDefinitionLoop(request: LoopRunRequest, runId: string, ports: DefinitionLoopExecutionPorts): Promise<DefinitionRuntimeResult> {
  let continuation: Pick<DefinitionLoopInvocation, 'resume' | 'answer' | 'approve' | 'interruptId' | 'recover' | 'hostResult'> = ports.continuation ?? {}
  for (;;) {
    if (ports.isCancelled()) return { text: '', runtimeStatus: 'cancelled', failed: true }
    const result = await ports.invoke({ request, runId, contextPath: ports.contextPath?.(), ...continuation,
      onPrepared: ports.onPrepared, onLine: ports.onLine, onRuntimeEvent: ports.onRuntimeEvent, onSpawn: ports.onSpawn, timeoutMs: ports.remainingMs() })
    ports.onInvocationEnd(result)
    if (ports.isCancelled()) return { ...result, runtimeStatus: 'cancelled', failed: true }
    if (result.runtimeStatus !== 'paused') return result
    const pending = result.pendingInterrupts ?? []
    if (!pending.length && result.pause && ports.awaitHostPause) {
      if ((await ports.awaitHostPause(result.pause)) === 'stop' || ports.isCancelled()) return { ...result, runtimeStatus: 'cancelled', failed: true }
      continuation = { resume: true }
      continue
    }
    // Machine interrupts first: a host task never waits for a person.
    const hostTask = pending.find(isHostTaskInterrupt)
    if (hostTask) {
      if (!ports.resolveHostTask) throw new Error(`host_task_unsupported: no handler can resolve host task ${hostTask.value.task}`)
      const resolved = await ports.resolveHostTask(hostTask)
      if (resolved.action === 'stop' || ports.isCancelled()) return { ...result, runtimeStatus: 'cancelled', failed: true }
      continuation = { resume: true, interruptId: hostTask.id, hostResult: resolved.result }
      if (ports.beforeContinuation && (await ports.beforeContinuation()) === 'stop' || ports.isCancelled()) {
        return { ...result, runtimeStatus: 'cancelled', failed: true }
      }
      continue
    }
    const reason = result.pendingQuestion?.question ?? result.pendingApproval?.reason ?? pending.map(item => {
      const value = item.value as { prompt?: unknown } | undefined
      return `${item.nodePath}: ${typeof value?.prompt === 'string' ? value.prompt : item.kind}`
    }).join('\n')
    if (!pending.length) throw new Error('Core paused without an addressable interrupt')
    const decision = await ports.awaitHumanDecision(reason, pending)
    if (decision.action === 'stop' || ports.isCancelled()) return { ...result, runtimeStatus: 'cancelled', failed: true }
    const selected = decision.interruptId ? pending.find(item => item.id === decision.interruptId) : pending.length === 1 ? pending[0] : undefined
    if (!selected) throw new Error('Select the pending question or approval to resume')
    if (selected.kind !== 'question' && decision.approve !== true) throw new Error('Explicit approval is required to resume this interrupt')
    continuation = selected.kind === 'question'
      ? { resume: true, answer: decision.text, interruptId: selected.id }
      : { resume: true, approve: [selected.id], interruptId: selected.id }
    if (ports.beforeContinuation && (await ports.beforeContinuation()) === 'stop' || ports.isCancelled()) {
      return { ...result, runtimeStatus: 'cancelled', failed: true }
    }
  }
}
