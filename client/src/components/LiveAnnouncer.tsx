import { useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SharedWebSocketContext } from '../hooks/useSharedWebSocket'
import { useDesktop } from '../hooks/useDesktop'
import { announce, announcer } from '../lib/announce'
import { runAnnouncementFor } from '../lib/run-announcements'

/**
 * The one polite `aria-live` region of the app. It speaks what `announce()` is
 * given, and announces run-state changes (started, paused, needs you, failed,
 * finished, review ready) for the ACTIVE project only. Visually hidden.
 */
export function LiveAnnouncer() {
  const { t } = useTranslation('common')
  const ws = useContext(SharedWebSocketContext)
  const { activeProjectId } = useDesktop()
  const [text, setText] = useState('')
  // Toggled so an identical sentence is re-announced after a gap.
  const flip = useRef(false)

  useEffect(() => announcer.subscribe((next) => {
    flip.current = !flip.current
    setText(flip.current ? next : `${next} `)
  }), [])

  const projectRef = useRef(activeProjectId)
  projectRef.current = activeProjectId
  const tRef = useRef(t)
  tRef.current = t
  const registerHandler = ws?.registerHandler
  const unregisterHandler = ws?.unregisterHandler
  useEffect(() => {
    if (!registerHandler || !unregisterHandler) return
    registerHandler('live-announcer', (message) => {
      const a = runAnnouncementFor(message, projectRef.current)
      if (!a) return
      const base = `a11y.announce.${a.kind}${a.detail ? a.detail[0].toUpperCase() + a.detail.slice(1) : ''}`
      // Most specific sentence the message supports: rail + spec, then rail, then the bare state.
      const key = a.rail === null ? base : a.ticketId !== null && !a.detail ? `${base}Spec` : `${base}Rail`
      announce(tRef.current(key, { rail: a.rail ?? undefined, id: a.ticketId ?? undefined }), a.key)
    })
    return () => unregisterHandler('live-announcer')
  }, [registerHandler, unregisterHandler])

  // A project switch forgets what was queued for the previous one.
  useEffect(() => { announcer.reset(); setText('') }, [activeProjectId])

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="live-announcer">
      {text}
    </div>
  )
}
