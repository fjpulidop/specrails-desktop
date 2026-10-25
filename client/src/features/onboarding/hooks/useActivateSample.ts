import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useDesktop } from '../../../hooks/useDesktop'
import { useUiMode } from '../../../context/UiModeContext'
import type { CreateSampleOutcome } from '../lib/sample-api'
import { clearGuideState } from '../lib/sample-guide-state'

/**
 * After the sample exists: make it the active project and land on the Board,
 * where the specs, the rails and the Review packet are all visible. A re-used
 * sample (already created) is simply opened again.
 */
export function useActivateSample(): (outcome: CreateSampleOutcome) => Promise<void> {
  const { refreshProjects, setActiveProjectId } = useDesktop()
  const { setUiMode } = useUiMode()
  const navigate = useNavigate()
  const { t } = useTranslation('onboarding')
  return useCallback(async (outcome) => {
    await refreshProjects()
    setActiveProjectId(outcome.project.id)
    setUiMode('kanban')
    navigate('/')
    if (!outcome.reused) clearGuideState()
    toast.success(t(outcome.reused ? 'toast.reopened' : 'toast.created', { name: outcome.project.name }))
  }, [refreshProjects, setActiveProjectId, setUiMode, navigate, t])
}
