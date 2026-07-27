import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BrowserCaptureModal } from '../browser-capture/BrowserCaptureModal'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useAgentChat } from '../../context/AgentChatContext'
import { uploadAgentAttachment } from '../../lib/agent-api'
import { dataUrlToFile } from '../../lib/data-url'
import type { CaptureResult } from '../../lib/browser-capture'

/**
 * Agent Browser tool — reuses the Explore live browser-capture flow. A capture
 * is project-scoped (sessions require an active project) and lands as an agent
 * attachment of the active conversation, then is queued so the composer adopts
 * it as a chip that rides the next manual send. On the EMPTY compose screen
 * (no conversation yet) the draft mission is materialized first — same
 * contract as attaching a file there — so a capture can start a mission.
 */
export function AgentBrowserCapture({ projectId, conversationId }: { projectId: string; conversationId: string | null }) {
  const { t } = useTranslation('agent')
  const { closeBrowser, queueCapture } = useAgentWorkspace()
  const { materializeDraftConversation } = useAgentChat()
  // A stable pending id per open so captures group under one dir.
  const pendingSpecId = useMemo(() => `agent-${conversationId ?? 'home'}-${Math.round(performance.now())}`, [conversationId])

  const onCaptured = async (result: CaptureResult) => {
    try {
      // No conversation yet (empty compose screen) — materialize the draft
      // mission so the capture has a home. The context migrates any typed
      // new-mission draft to the created conversation, so nothing is lost.
      const convId = conversationId ?? (await materializeDraftConversation()).id
      // Re-home the screenshot into the conversation's agent-attachment storage —
      // the send path resolves attachment ids exclusively from there. Decoded
      // without fetch(): the packaged CSP connect-src rejects data: URLs.
      const file = dataUrlToFile(result.screenshotDataUrl, `capture-${Date.now()}.png`)
      const att = await uploadAgentAttachment(convId, file)
      queueCapture(att)
      toast.success(t('workspace.browserCaptured'))
      closeBrowser()
    } catch (err) {
      toast.error(t('workspace.uploadFailed'), {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  return (
    <BrowserCaptureModal
      open
      onClose={closeBrowser}
      projectId={projectId}
      pendingSpecId={pendingSpecId}
      confirmLabel={t('workspace.browserConfirm')}
      selectLabel={t('workspace.browserSelectStart')}
      onCaptured={(result) => { void onCaptured(result) }}
    />
  )
}
