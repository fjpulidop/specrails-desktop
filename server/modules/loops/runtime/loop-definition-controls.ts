import { runQuestionFrom } from '../../../shared/run-question'
import type { DefinitionResumeControls } from './loop-definition-run'
import type { DefinitionRunProbe } from './loop-definition-recovery'

/** Resolve controls against the latest retained journal, never against UI labels or node paths. */
export function validateDefinitionResumeControls(value: unknown, probe: DefinitionRunProbe): DefinitionResumeControls {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resume controls must be an object')
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => !['answer', 'optionId', 'interruptId', 'approve', 'reject', 'reason', 'recover', 'routeOverrides'].includes(key))) throw new Error('Unknown resume control')
  // Core routeOverrides (a switch at a usage limit): a plain resume that moves roles; Core validates the request itself.
  if (body.routeOverrides !== undefined) {
    const override = body.routeOverrides as { schemaVersion?: unknown; requestId?: unknown; routes?: unknown } | null
    if (!override || typeof override !== 'object' || override.schemaVersion !== 1 || typeof override.requestId !== 'string' || !override.routes || typeof override.routes !== 'object') throw new Error('Invalid route override')
    if (['answer', 'optionId', 'interruptId', 'approve', 'reject', 'reason'].some(key => body[key] !== undefined)) throw new Error('A route override resumes the run as is')
    const recover = Array.isArray(body.recover) ? (body.recover as unknown[]).filter((id): id is string => typeof id === 'string' && probe.recoverableSteps.some(item => item.attemptId === id)) : undefined
    return { routeOverrides: body.routeOverrides as DefinitionResumeControls['routeOverrides'], ...(recover?.length ? { recover } : {}) }
  }
  if (body.answer !== undefined && (typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 20_000)) throw new Error('Answer must be nonempty and contain at most 20000 characters')
  if (body.interruptId !== undefined && (typeof body.interruptId !== 'string' || !body.interruptId)) throw new Error('An exact interrupt ID is required')
  const ids = (key: 'approve' | 'recover'): string[] | undefined => {
    const values = body[key]
    if (values === undefined) return undefined
    if (!Array.isArray(values) || values.length > 10_000 || values.some(id => typeof id !== 'string' || !id) || new Set(values).size !== values.length) throw new Error(`${key} must contain unique IDs`)
    return values as string[]
  }
  const approve = ids('approve'), recover = ids('recover')
  const pendingAll = probe.pendingInterrupts
  // Core questionOptions: a choice the question offered, or one rejectable approval with a reason.
  if (body.optionId !== undefined && (typeof body.optionId !== 'string' || body.answer === undefined)) throw new Error('A chosen option needs its answer text')
  if (body.reject !== undefined) {
    if (typeof body.reject !== 'string' || !body.reject || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 20_000) throw new Error('A rejection needs the approval ID and a reason')
    if (body.answer !== undefined || approve?.length) throw new Error('Submit a rejection on its own')
    const target = pendingAll.find(item => item.id === body.reject)
    if (!target || !runQuestionFrom([target])?.canReject) throw new Error('Rejection is not available for this approval')
    return { reject: body.reject, reason: body.reason as string, interruptId: body.reject, ...(recover ? { recover } : {}) }
  } else if (body.reason !== undefined) throw new Error('A reason applies to a rejection')
  if (body.answer !== undefined && approve?.length) throw new Error('Submit an answer or approvals separately')
  const pending = probe.pendingInterrupts
  if (approve?.some(id => !pending.some(item => item.id === id && (item.kind === 'approval' || item.kind === 'gate')))) throw new Error('Approval is no longer pending')
  if (recover?.some(id => !probe.recoverableSteps.some(item => item.attemptId === id))) throw new Error('Recovery requires an exact recoverable attempt ID')
  let interruptId = body.interruptId as string | undefined
  if (body.answer !== undefined && !interruptId) {
    const questions = pending.filter(item => item.kind === 'question')
    if (questions.length !== 1) throw new Error('Select an exact pending question')
    interruptId = questions[0].id
  }
  if (interruptId && !pending.some(item => item.id === interruptId)) throw new Error('Interrupt is no longer pending')
  if (body.answer !== undefined && !pending.some(item => item.id === interruptId && item.kind === 'question')) throw new Error('Answers require a pending question')
  if (interruptId && body.answer === undefined && !approve?.includes(interruptId)) throw new Error('Select an answer or approval for the interrupt')
  if (typeof body.optionId === 'string' && !runQuestionFrom(pending.filter(item => item.id === interruptId))?.options.some(option => option.id === body.optionId)) throw new Error('The chosen option is not one the question offered')
  return {
    ...(body.answer === undefined ? {} : { answer: body.answer as string }),
    ...(typeof body.optionId === 'string' ? { optionId: body.optionId } : {}),
    ...(interruptId ? { interruptId } : {}), ...(approve ? { approve } : {}), ...(recover ? { recover } : {}),
  }
}
