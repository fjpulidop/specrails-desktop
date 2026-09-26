import type { DefinitionResumeControls } from './loop-definition-run'
import type { DefinitionRunProbe } from './loop-definition-recovery'

/** Resolve controls against the latest retained journal, never against UI labels or node paths. */
export function validateDefinitionResumeControls(value: unknown, probe: DefinitionRunProbe): DefinitionResumeControls {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resume controls must be an object')
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => !['answer', 'interruptId', 'approve', 'recover'].includes(key))) throw new Error('Unknown resume control')
  if (body.answer !== undefined && (typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 20_000)) throw new Error('Answer must be nonempty and contain at most 20000 characters')
  if (body.interruptId !== undefined && (typeof body.interruptId !== 'string' || !body.interruptId)) throw new Error('An exact interrupt ID is required')
  const ids = (key: 'approve' | 'recover'): string[] | undefined => {
    const values = body[key]
    if (values === undefined) return undefined
    if (!Array.isArray(values) || values.length > 10_000 || values.some(id => typeof id !== 'string' || !id) || new Set(values).size !== values.length) throw new Error(`${key} must contain unique IDs`)
    return values as string[]
  }
  const approve = ids('approve'), recover = ids('recover')
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
  return {
    ...(body.answer === undefined ? {} : { answer: body.answer as string }),
    ...(interruptId ? { interruptId } : {}), ...(approve ? { approve } : {}), ...(recover ? { recover } : {}),
  }
}
