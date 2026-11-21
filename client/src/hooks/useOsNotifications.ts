import { useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useSharedWebSocket } from './useSharedWebSocket'
import i18n from '../lib/i18n'
import { useUiMode } from '../context/UiModeContext'
import { requestMissionOpenRun } from '../features/missions/components/agent-run-failure'
import { requestOpenInbox } from '../lib/inbox-events'
import { JOB_PARAM } from '../lib/places'
import { appAttention } from '../lib/attention/app-attention'
import type { AttentionCenter } from '../lib/attention/attention-center'
import { attentionPrefsStore } from '../lib/attention/attention-prefs-store'
import { decideAttention } from '../lib/attention/attention-policy'
import { isMainFocused, type WindowFocus } from '../lib/attention/window-focus'
import { notifyError } from '../lib/notify-error'
import { API_ORIGIN } from '../lib/origin'
import { formatResetTime } from '../features/provider-quota/lib/format-reset'

interface WsJob {
  id: string
  status: string
  command?: string
}

interface UseOsNotificationsOpts {
  /** Called on notification click to switch to the job's project (Super mode) */
  setActiveProjectId?: (id: string) => void
  /** projectId → projectName map for notification body text */
  projectsById?: Map<string, string>
  /** The attention pipeline (tests inject their own). */
  center?: AttentionCenter
}

/** The job's own place (`/jobs/:id` on the board, `?job=` over a mission) is what the main window shows. */
function jobOnScreen(jobId: string) {
  return (focus: WindowFocus): boolean => {
    if (!isMainFocused(focus) || typeof window === 'undefined') return false
    const { pathname, search } = window.location
    return pathname === `/jobs/${jobId}` || new URLSearchParams(search).get(JOB_PARAM) === jobId
  }
}

/**
 * Job attention through the app's attention pipeline (`lib/attention`):
 * running → completed (category `done`) or running → failed (`failed`), a run
 * that stopped moving (`job.stuck`, `failed`, interrupts even a focused window)
 * and a provider usage limit (`loop.provider_limit`, `budget`).
 *
 * The pipeline decides: an OS notification when the person is away, an in-app
 * toast when the app is focused elsewhere, nothing when the job is on screen,
 * the category is off or the project is muted (Settings ▸ Notifications).
 */
export function useOsNotifications({
  setActiveProjectId,
  projectsById,
  center = appAttention,
}: UseOsNotificationsOpts = {}): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])

  const setActiveProjectIdRef = useRef(setActiveProjectId)
  useEffect(() => { setActiveProjectIdRef.current = setActiveProjectId }, [setActiveProjectId])
  // mission-rail-cards: in Mission mode a notification click must not leave
  // the mission for the routed `/jobs/:id` page — it opens the run inside the
  // workspace (Jobs pane → JobDetailModal) instead. Read through a ref so the
  // WS handler below (registered once) always sees the current mode.
  const { uiMode } = useUiMode()
  const uiModeRef = useRef(uiMode)
  useEffect(() => { uiModeRef.current = uiMode }, [uiMode])
  const openJob = useCallback((projectId: string | null, jobId: string): void => {
    if (uiModeRef.current === 'agent') {
      if (projectId && setActiveProjectIdRef.current) setActiveProjectIdRef.current(projectId)
      requestMissionOpenRun({ projectId, jobId })
      return
    }
    if (projectId && setActiveProjectIdRef.current) {
      setActiveProjectIdRef.current(projectId)
      setTimeout(() => { navigateRef.current(`/jobs/${jobId}`) }, 100)
    } else {
      navigateRef.current(`/jobs/${jobId}`)
    }
  }, [])

  const projectsByIdRef = useRef(projectsById)
  useEffect(() => { projectsByIdRef.current = projectsById }, [projectsById])
  const centerRef = useRef(center)
  useEffect(() => { centerRef.current = center }, [center])

  // jobId → last known status (to detect running → terminal transitions)
  const jobStatesRef = useRef(new Map<string, string>())

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as {
      type?: string; projectId?: string; jobs?: WsJob[]
      jobId?: string; staleMs?: number; actions?: unknown
      runId?: unknown; provider?: unknown; resetsAt?: unknown; resumeAt?: unknown; message?: unknown
    }
    if (!msg) return
    // A commissioned run that stopped moving. The server fires this at most once
    // per stall episode, so no client-side dedup is needed.
    if (msg.type === 'job.stuck' && typeof msg.jobId === 'string') {
      const actions = Array.isArray(msg.actions) ? msg.actions.filter((a): a is 'stop' => a === 'stop') : []
      void fireStuck(msg.jobId, msg.projectId ?? null, msg.staleMs ?? 0, actions)
      return
    }
    // The provider answered a loop step with a usage/rate-limit notice: the run
    // stopped at once (no cycling). Say so with the provider's reset hint —
    // the one fact the user needs to decide when to relaunch.
    if (msg.type === 'loop.provider_limit' && typeof msg.runId === 'string') {
      void fireProviderLimit(
        msg.runId,
        msg.projectId ?? null,
        typeof msg.provider === 'string' ? msg.provider : '',
        // The exact instant (provider-quota) reads in the person's clock; the provider's words are the fallback.
        typeof msg.resumeAt === 'string' && Number.isFinite(Date.parse(msg.resumeAt)) ? formatResetTime(msg.resumeAt, i18n.language)
          : typeof msg.resetsAt === 'string' && msg.resetsAt ? msg.resetsAt : null,
        typeof msg.message === 'string' ? msg.message : '',
      )
      return
    }
    if (msg.type !== 'queue' || !Array.isArray(msg.jobs)) return

    const projectId = msg.projectId ?? null
    for (const job of msg.jobs) {
      const prevStatus = jobStatesRef.current.get(job.id)
      // Only a transition from running → completed/failed is news.
      if (prevStatus === 'running' && (job.status === 'completed' || job.status === 'failed')) void fireJobSettled(job, projectId)
      jobStatesRef.current.set(job.id, job.status)
    }
  }, [])

  function projectNameOf(projectId: string | null): string {
    return projectId ? (projectsByIdRef.current?.get(projectId) ?? '') : ''
  }

  function withProject(projectId: string | null, body: string): string {
    const projectName = projectNameOf(projectId)
    return projectName ? `[${projectName}] ${body}` : body
  }

  async function fireJobSettled(job: WsJob, projectId: string | null): Promise<void> {
    const completed = job.status === 'completed'
    const category = completed ? 'done' : 'failed'
    await centerRef.current.dispatch({
      key: `job:${job.id}:${job.status}`,
      subjectKey: `${category}:run:${job.id}`,
      category,
      projectId,
      title: completed ? i18n.t('commands:notifications.jobCompleted') : i18n.t('commands:notifications.jobFailed'),
      body: withProject(projectId, job.command ? job.command.slice(0, 80) : i18n.t('commands:notifications.unknownCommand')),
      isOnScreen: jobOnScreen(job.id),
      open: () => openJob(projectId, job.id),
      copy: { kind: completed ? 'done' : 'stopped', project: projectNameOf(projectId), subject: job.command ?? null },
    })
  }

  async function fireProviderLimit(runId: string, projectId: string | null, provider: string, resetsAt: string | null, message: string): Promise<void> {
    const providerName = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'AI'
    const body = resetsAt
      ? i18n.t('commands:notifications.providerLimitBody', { provider: providerName, resetsAt })
      : i18n.t('commands:notifications.providerLimitBodyNoReset', { provider: providerName })
    const title = i18n.t('commands:notifications.providerLimit')
    // The in-app error (with the provider's own message) stays the in-app form of this alert.
    const showError = (): void => {
      notifyError(title, { id: `provider-limit:${runId}`, detail: `${withProject(projectId, body)}${message ? ` · ${message}` : ''}`, duration: 60_000 })
    }
    const decision = await centerRef.current.dispatch({
      key: `provider-limit:${runId}`,
      subjectKey: `budget:run:${runId}`,
      category: 'budget',
      projectId,
      title,
      body: withProject(projectId, body),
      // A provider limit has no single job to open: it lands on the inbox, where every
      // project's blocked runs wait with their Resume / Open action.
      open: requestOpenInbox,
      inAppToast: showError,
      copy: { kind: 'paused', project: projectNameOf(projectId) },
    })
    if (decision === 'notify') showError()
  }

  /**
   * Plain-language stall alert. Unlike completion notifications this fires even
   * with the window focused: a user watching a wedged run cannot tell it wedged,
   * which is the entire reason the signal exists.
   */
  async function fireStuck(jobId: string, projectId: string | null, staleMs: number, actions: Array<'stop'>): Promise<void> {
    const minutes = Math.max(1, Math.round(staleMs / 60_000))
    const body = withProject(projectId, i18n.t('commands:notifications.jobStuckBody', { count: minutes }))
    const title = i18n.t('commands:notifications.jobStuck')

    // Actionable in-app alert (loop-step-idle): the server advertises `stop`
    // when the existing cancel route can end the run — offer it right on the
    // toast so a wedged run is one click from settled. It follows the same
    // prefs (off, failures off or project muted → nothing) but not the focus.
    const prefs = await attentionPrefsStore.ready()
    const allowed = decideAttention({ category: 'failed', projectId, windowFocused: false, placeOnScreen: false }, prefs) !== 'skip'
    if (allowed && projectId && actions.includes('stop')) {
      toast.warning(title, {
        id: `job-stuck:${jobId}`,
        description: body,
        duration: 20_000,
        action: {
          label: i18n.t('commands:notifications.jobStuckStop'),
          onClick: () => { void stopStuckRun(projectId, jobId) },
        },
      })
    }

    await centerRef.current.dispatch({
      key: `job-stuck:${jobId}:${staleMs}`,
      subjectKey: `failed:run:${jobId}`,
      category: 'failed',
      projectId,
      title,
      body,
      persistent: true,
      open: () => openJob(projectId, jobId),
      copy: { kind: 'stuck', project: projectNameOf(projectId) },
    })
  }

  /** "Stop run" from the stuck toast → the EXISTING cancel route (loop runs
   *  route through it to LoopRunManager.cancel; no new endpoint). */
  async function stopStuckRun(projectId: string, jobId: string): Promise<void> {
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(i18n.t('commands:notifications.jobStuckStopped'), { id: `job-stuck:${jobId}` })
    } catch {
      notifyError(i18n.t('commands:notifications.jobStuckStopFailed'), { id: `job-stuck:${jobId}` })
    }
  }

  useLayoutEffect(() => {
    registerHandler('os-notifications', handleMessage)
    return () => unregisterHandler('os-notifications')
  }, [handleMessage, registerHandler, unregisterHandler])
}
