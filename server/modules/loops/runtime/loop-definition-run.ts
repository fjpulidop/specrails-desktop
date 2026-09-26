import type { ChildProcess } from 'node:child_process'
import type { AiStepResult, LoopRunRequest } from './loop-run-manager'

export interface DefinitionCompletion {
  ok: boolean
  verified: boolean
  reasons: string[]
}
export interface DefinitionInterrupt {
  id: string
  nodePath: string
  scopeId?: string
  kind: 'question' | 'approval' | 'gate'
  attemptId?: string
  value?: unknown
}
export interface DefinitionRuntimeResult extends AiStepResult {
  runtimeStatus: 'succeeded' | 'paused' | 'failed' | 'blocked' | 'cancelled'
  completion?: DefinitionCompletion
  pendingInterrupts?: DefinitionInterrupt[]
  pendingQuestion?: { stepId?: string; question?: string }
  pendingApproval?: { stepId?: string; reason?: string }
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
export interface DefinitionResumeControls { answer?: string; approve?: string[]; interruptId?: string; recover?: string[] }
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
  onLine(line: string, source?: 'stdout' | 'stderr'): void
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
  onLine(line: string, source?: 'stdout' | 'stderr'): void
  onRuntimeEvent(event: Record<string, unknown>): void
  onSpawn(child: ChildProcess): void
  onPrepared?(metadata: DefinitionPrepared): void
  onInvocationEnd(result: DefinitionRuntimeResult): void
  awaitHumanDecision(reason: string, pending: DefinitionInterrupt[]): Promise<{ action: 'stop' } | { action: 'resume'; text: string; interruptId?: string; approve?: boolean }>
}

/** One retained Core process at a time; all graph scheduling remains in Core. */
export async function runDefinitionLoop(request: LoopRunRequest, runId: string, ports: DefinitionLoopExecutionPorts): Promise<DefinitionRuntimeResult> {
  let continuation: Pick<DefinitionLoopInvocation, 'resume' | 'answer' | 'approve' | 'interruptId' | 'recover'> = ports.continuation ?? {}
  for (;;) {
    if (ports.isCancelled()) return { text: '', runtimeStatus: 'cancelled', failed: true }
    const result = await ports.invoke({ request, runId, contextPath: ports.contextPath?.(), ...continuation,
      onPrepared: ports.onPrepared, onLine: ports.onLine, onRuntimeEvent: ports.onRuntimeEvent, onSpawn: ports.onSpawn, timeoutMs: ports.remainingMs() })
    ports.onInvocationEnd(result)
    if (ports.isCancelled()) return { ...result, runtimeStatus: 'cancelled', failed: true }
    if (result.runtimeStatus !== 'paused') return result
    const pending = result.pendingInterrupts ?? []
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
  }
}
