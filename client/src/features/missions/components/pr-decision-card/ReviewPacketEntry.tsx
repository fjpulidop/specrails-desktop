/**
 * Route entry from a PR decision card into the plain-language review packet,
 * switching to the card's project first when it is not the active one.
 */
import { Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useDesktop } from '../../../../hooks/useDesktop'
import { forceProjectRoute } from '../../../../lib/route-memory'

/** Route entry into the plain-language review packet. Split out so the parent
 *  card can stay renderable without a Router (see inRouterContext there). */
export function ReviewPacketEntry({ prDeliveryId, projectId }: { prDeliveryId: string; projectId: string }) {
  const { t } = useTranslation('agent')
  const navigate = useNavigate()
  const { activeProjectId, setActiveProjectId } = useDesktop()
  return (
    <button
      type="button"
      onClick={() => {
        const route = `/review/${prDeliveryId}`
        // Review packets use the active project's API. Pin route memory before
        // switching so the app cannot restore a different page over this one.
        if (activeProjectId !== projectId) {
          forceProjectRoute(projectId, route)
          setActiveProjectId(projectId)
        }
        navigate(route)
      }}
      data-testid="agent-pr-open-packet"
      data-agent-interactive
      title={t('prCard.openReviewTooltip')}
      className="inline-flex items-center gap-1 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2 py-1 text-caption font-medium text-accent-primary transition-colors hover:bg-accent-primary/20"
    >
      <Eye className="h-3 w-3" />
      {t('prCard.openReview')}
    </button>
  )
}
