import { useEffect, useId, useRef, useState } from 'react'
import { RunQuestionCard } from '../../../../components/run-question/RunQuestionCard'
import { onRunQuestionAnswered, plainRunQuestion, readRunQuestion, runQuestionSettledBy, type RunQuestion } from '../../../../components/run-question/run-question'
import { useSharedWebSocket } from '../../../../hooks/useSharedWebSocket'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'
import { answerableRun } from './job-run-model'

function useSharedWebSocketOptional(): ReturnType<typeof useSharedWebSocket> | null {
  try { return useSharedWebSocket() } catch { return null }
}

/** A run window's question, the engine that answers it and, for a runtime execution, its own id. */
export interface RunWindowQuestion { question: RunQuestion; engine: 1 | 2; runId?: string }

/** The question of a run window: the live pause's card, else what its runtime execution still asks. */
export function runWindowQuestion(job: { question?: unknown; loopPauseReason?: string | null; loopPaused?: boolean; loopPauseKind?: string | null }, run: RuntimeRun | undefined): RunWindowQuestion | null {
  const card = readRunQuestion(job.question)
  if (card) return { question: card, engine: 2 }
  const runtime = answerableRun(run)
  if (runtime) {
    const structured = readRunQuestion(runtime.question)
    const engine = runtime.engineVersion === 2 ? 2 : 1
    // The runtime execution answers under its own id.
    if (structured) return { question: structured, engine, runId: runtime.runId }
    return { question: plainRunQuestion(runtime.pendingQuestion!.question, engine === 2 ? runtime.pendingQuestion!.stepId : ''), engine, runId: runtime.runId }
  }
  // A legacy loop pause (no Core interrupt) still asks in plain words.
  if (job.loopPaused && !job.loopPauseKind && job.loopPauseReason) return { question: plainRunQuestion(job.loopPauseReason), engine: 2 }
  return null
}

/**
 * The run window's one place for the question: docked above the log's composer,
 * live from the server's pause events, gone the moment any surface answers it.
 */
export function RunQuestionDock({ projectId, runId, initial, onAnswered }: {
  projectId: string
  runId: string
  initial: RunWindowQuestion | null
  onAnswered?: () => void
}) {
  const [current, setCurrent] = useState(initial)
  const answeredHere = useRef(false)
  // Answered here: the confirmation stays a moment, then the dock steps aside (see onAnswered below).
  useEffect(() => { if (!answeredHere.current || initial) { answeredHere.current = false; setCurrent(initial) } }, [initial?.question.interruptId, initial?.question.text, initial?.engine]) // eslint-disable-line react-hooks/exhaustive-deps
  const ws = useSharedWebSocketOptional()
  const uid = useId()
  // Listens only while it shows a question: a new one arrives with the run window's own refetch.
  const showing = current !== null
  useEffect(() => {
    if (!ws || !showing) return
    const id = `run-question-dock-${runId}-${uid}`
    ws.registerHandler(id, (message) => {
      const m = message as Record<string, unknown> | null
      if (!m || m.projectId !== projectId) return
      const target = typeof m.jobId === 'string' ? m.jobId : m.loopRunId
      if (target !== runId) return
      if (runQuestionSettledBy(m)) { if (!answeredHere.current) setCurrent(null); return }
      const asked = (m.type === 'job.interactive' || m.type === 'loop.run_paused') ? readRunQuestion(m.question) : null
      if (asked) { answeredHere.current = false; setCurrent({ question: asked, engine: 2 }) }
    })
    return () => ws.unregisterHandler(id)
  }, [ws, projectId, runId, uid, showing])
  useEffect(() => onRunQuestionAnswered((answered) => {
    if (answered.projectId === projectId && answered.runId === runId) onAnswered?.()
  }), [projectId, runId, onAnswered])
  if (!current) return null
  return (
    <div className="shrink-0 px-3 py-2" data-run-question-dock={runId}>
      <RunQuestionCard question={current.question} projectId={projectId} runId={current.runId ?? runId} engine={current.engine}
        onAnswered={() => { answeredHere.current = true; setTimeout(() => { if (answeredHere.current) { answeredHere.current = false; setCurrent(null) } }, 4000) }} />
    </div>
  )
}

/** Moves focus to the run window's question (the header's Answer). */
export function focusRunQuestion(runId: string): void {
  const dock = document.querySelector(`[data-run-question-dock="${CSS.escape(runId)}"]`)
  dock?.scrollIntoView({ block: 'nearest' })
  const control = dock?.querySelector<HTMLElement>('[data-testid="run-question-option"], [data-testid="run-question-approve"], textarea')
  control?.focus()
}
