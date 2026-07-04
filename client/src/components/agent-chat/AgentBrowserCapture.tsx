import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BrowserCaptureModal } from '../browser-capture/BrowserCaptureModal'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { uploadAgentAttachment } from '../../lib/agent-api'
import { dataUrlToFile } from '../../lib/data-url'
import type { CaptureResult } from '../../lib/browser-capture'

/**
 * Agent-Mode Browser tool — reuses the Explore live browser-capture flow. A
 * capture is project-scoped (sessions require an active project) AND
 * conversation-keyed (the screenshot is uploaded as an agent attachment of the
 * active conversation, then queued so the composer adopts it as a chip that
 * rides the next manual send). The sidebar disables the tool when either is
 * missing.
 */
export function AgentBrowserCapture({ projectId, conversationId }: { projectId: string; conversationId: string | null }) {
  const { t } = useTranslation('agent')
  const { closeBrowser, queueCapture } = useAgentWorkspace()
  // A stable pending id per open so captures group under one dir.
  const pendingSpecId = useMemo(() => `agent-${conversationId ?? 'home'}-${Math.round(performance.now())}`, [conversationId])

  const onCaptured = async (result: CaptureResult) => {
    if (!conversationId) {
      toast.error(t('workspace.requiresConversation'))
      return
    }
    try {
      // Re-home the screenshot into the conversation's agent-attachment storage —
      // the send path resolves attachment ids exclusively from there. Decoded
      // without fetch(): the packaged CSP connect-src rejects data: URLs.
      const file = dataUrlToFile(result.screenshotDataUrl, `capture-${Date.now()}.png`)
      const att = await uploadAgentAttachment(conversationId, file)
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
      onCaptured={(result) => { void onCaptured(result) }}
    />
  )
}
