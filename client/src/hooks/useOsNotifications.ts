import { useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useSharedWebSocket } from './useSharedWebSocket'
import i18n from '../lib/i18n'

interface WsJob {
  id: string
  status: string
  command?: string
}

export type OsNotificationFilter = 'all' | 'completed' | 'failed'

export interface OsNotificationPrefs {
  enabled: boolean
  filter: OsNotificationFilter
}

const STORAGE_KEY = 'specrails-os-notifications'

const DEFAULT_PREFS: OsNotificationPrefs = { enabled: true, filter: 'all' }

export function getOsNotificationPrefs(): OsNotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<OsNotificationPrefs>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_PREFS.enabled,
      filter: parsed.filter === 'completed' || parsed.filter === 'failed' ? parsed.filter : DEFAULT_PREFS.filter,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function setOsNotificationPrefs(prefs: OsNotificationPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

interface UseOsNotificationsOpts {
  /** Called on notification click to switch to the job's project (Super mode) */
  setActiveProjectId?: (id: string) => void
  /** projectId → projectName map for notification body text */
  projectsById?: Map<string, string>
}

/**
 * Sends OS notifications (Browser Notification API) when jobs transition
 * from running → completed or running → failed. Clicking a notification
 * focuses the window, optionally switches the active project, and navigates
 * to the job detail page.
 *
 * Only fires when the tab does NOT have focus (document.hidden === true).
 * Respects user preferences stored in localStorage (enabled, filter).
 */
export function useOsNotifications({
  setActiveProjectId,
  projectsById,
}: UseOsNotificationsOpts = {}): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => { navigateRef.current = navigate }, [navigate])

  const setActiveProjectIdRef = useRef(setActiveProjectId)
  useEffect(() => { setActiveProjectIdRef.current = setActiveProjectId }, [setActiveProjectId])

  const projectsByIdRef = useRef(projectsById)
  useEffect(() => { projectsByIdRef.current = projectsById }, [projectsById])

  // jobId → last known status (to detect running → terminal transitions)
  const jobStatesRef = useRef(new Map<string, string>())
  // jobId → projectId (for cross-project navigation)
  const jobProjectsRef = useRef(new Map<string, string>())

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as {
      type?: string; projectId?: string; jobs?: WsJob[]
      jobId?: string; staleMs?: number; actions?: unknown
      runId?: unknown; provider?: unknown; resetsAt?: unknown; message?: unknown
    }
    if (!msg) return
    // A commissioned run that stopped moving. The server fires this at most once
    // per stall episode, so no client-side dedup is needed. Treated as a
    // 'failed'-flavoured alert for filtering: it is bad news about a run.
    if (msg.type === 'job.stuck' && typeof msg.jobId === 'string') {
      const actions = Array.isArray(msg.actions) ? msg.actions.filter((a): a is 'stop' => a === 'stop') : []
      fireStuckNotification(msg.jobId, msg.projectId ?? null, msg.staleMs ?? 0, actions)
      return
    }
    // The provider answered a loop step with a usage/rate-limit notice: the run
    // stopped at once (no cycling). Say so with the provider's reset hint —
    // the one fact the user needs to decide when to relaunch.
    if (msg.type === 'loop.provider_limit' && typeof msg.runId === 'string') {
      fireProviderLimitNotification(
        msg.runId,
        msg.projectId ?? null,
        typeof msg.provider === 'string' ? msg.provider : '',
        typeof msg.resetsAt === 'string' && msg.resetsAt ? msg.resetsAt : null,
        typeof msg.message === 'string' ? msg.message : '',
      )
      return
    }
    if (msg.type !== 'queue' || !Array.isArray(msg.jobs)) return

    const projectId = msg.projectId ?? null

    for (const job of msg.jobs) {
      const prevStatus = jobStatesRef.current.get(job.id)
      const newStatus = job.status

      if (projectId) jobProjectsRef.current.set(job.id, projectId)

      // Only notify on transition from running → completed/failed
      if (prevStatus === 'running' && (newStatus === 'completed' || newStatus === 'failed')) {
        fireOsNotification(job, projectId)
      }

      jobStatesRef.current.set(job.id, newStatus)
    }
  }, [])

  function fireProviderLimitNotification(
    runId: string,
    projectId: string | null,
    provider: string,
    resetsAt: string | null,
    message: string,
  ): void {
    const prefs = getOsNotificationPrefs()
    if (!prefs.enabled) return
    if (prefs.filter === 'completed') return
    const projectName = projectId ? (projectsByIdRef.current?.get(projectId) ?? '') : ''
    const providerName = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'AI'
    const body = resetsAt
      ? i18n.t('commands:notifications.providerLimitBody', { provider: providerName, resetsAt })
      : i18n.t('commands:notifications.providerLimitBodyNoReset', { provider: providerName })
    const title = i18n.t('commands:notifications.providerLimit')
    toast.error(title, {
      id: `provider-limit:${runId}`,
      description: `${projectName ? `[${projectName}] ` : ''}${body}${message ? ` · ${message}` : ''}`,
      duration: 60_000,
    })
    if (typeof Notification === 'undefined') return
    const show = (): void => {
      const n = new Notification(title, { body: projectName ? `[${projectName}] ${body}` : body, tag: `specrails-provider-limit:${runId}` })
      n.onclick = () => { window.focus(); n.close() }
    }
    if (Notification.permission === 'granted') show()
  }

  /**
   * Plain-language stall alert. Unlike completion notifications this fires even
   * with the tab focused: a user watching a wedged run cannot tell it wedged,
   * which is the entire reason the signal exists.
   */
  function fireStuckNotification(
    jobId: string,
    projectId: string | null,
    staleMs: number,
    actions: Array<'stop'> = [],
  ): void {
    const prefs = getOsNotificationPrefs()
    if (!prefs.enabled) return
    if (prefs.filter === 'completed') return

    const minutes = Math.max(1, Math.round(staleMs / 60_000))
    const projectName = projectId ? (projectsByIdRef.current?.get(projectId) ?? '') : ''
    const body = i18n.t('commands:notifications.jobStuckBody', { count: minutes })

    // Actionable in-app alert (loop-step-idle): the server advertises `stop`
    // when the existing cancel route can end the run — offer it right on the
    // toast so a wedged run is one click from settled. Independent of OS
    // notification permission (an in-app surface, not a system one).
    if (projectId && actions.includes('stop')) {
      toast.warning(i18n.t('commands:notifications.jobStuck'), {
        id: `job-stuck:${jobId}`,
        description: projectName ? `[${projectName}] ${body}` : body,
        duration: 20_000,
        action: {
          label: i18n.t('commands:notifications.jobStuckStop'),
          onClick: () => { void stopStuckRun(projectId, jobId) },
        },
      })
    }

    if (typeof Notification === 'undefined') return

    function show(): void {
      const notification = new Notification(i18n.t('commands:notifications.jobStuck'), {
        body: projectName ? `[${projectName}] ${body}` : body,
        tag: `specrails-job-stuck:${jobId}`,
      })
      notification.onclick = () => {
        window.focus()
        if (projectId && setActiveProjectIdRef.current) {
          setActiveProjectIdRef.current(projectId)
          setTimeout(() => { navigateRef.current(`/jobs/${jobId}`) }, 100)
        } else {
          navigateRef.current(`/jobs/${jobId}`)
        }
        notification.close()
      }
    }

    if (Notification.permission === 'granted') show()
    else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((perm) => { if (perm === 'granted') show() })
    }
  }

  /** "Stop run" from the stuck toast → the EXISTING cancel route (loop runs
   *  route through it to LoopRunManager.cancel; no new endpoint). */
  async function stopStuckRun(projectId: string, jobId: string): Promise<void> {
    try {
      const res = await fetch(`/api/projects/${projectId}/jobs/${jobId}/cancel`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(i18n.t('commands:notifications.jobStuckStopped'), { id: `job-stuck:${jobId}` })
    } catch {
      toast.error(i18n.t('commands:notifications.jobStuckStopFailed'), { id: `job-stuck:${jobId}` })
    }
  }

  function fireOsNotification(job: WsJob, projectId: string | null): void {
    if (typeof Notification === 'undefined') return

    // Only notify when the tab does NOT have focus
    if (typeof document !== 'undefined' && !document.hidden) return

    // Check user preferences
    const prefs = getOsNotificationPrefs()
    if (!prefs.enabled) return
    if (prefs.filter === 'completed' && job.status !== 'completed') return
    if (prefs.filter === 'failed' && job.status !== 'failed') return

    function show(): void {
      const title = job.status === 'completed'
        ? i18n.t('commands:notifications.jobCompleted')
        : i18n.t('commands:notifications.jobFailed')
      const projectName = projectId ? (projectsByIdRef.current?.get(projectId) ?? '') : ''
      const commandSnippet = job.command ? job.command.slice(0, 80) : i18n.t('commands:notifications.unknownCommand')
      const body = projectName ? `[${projectName}] ${commandSnippet}` : commandSnippet

      const notification = new Notification(title, {
        body,
        tag: `specrails-job:${job.id}:${job.status}`,
      })

      const jobId = job.id
      const targetProjectId = projectId

      notification.onclick = () => {
        window.focus()
        if (targetProjectId && setActiveProjectIdRef.current) {
          setActiveProjectIdRef.current(targetProjectId)
          setTimeout(() => {
            navigateRef.current(`/jobs/${jobId}`)
          }, 100)
        } else {
          navigateRef.current(`/jobs/${jobId}`)
        }
        notification.close()
      }
    }

    if (Notification.permission === 'granted') {
      show()
    } else if (Notification.permission === 'default') {
      void Notification.requestPermission().then((perm) => {
        if (perm === 'granted') show()
      })
    }
    // 'denied' → do nothing
  }

  useLayoutEffect(() => {
    registerHandler('os-notifications', handleMessage)
    return () => unregisterHandler('os-notifications')
  }, [handleMessage, registerHandler, unregisterHandler])
}
