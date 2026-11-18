/**
 * Per-project specs board view preferences: sort mode/direction and the view
 * tier (rows vs post-its), reloaded on project switch, following the app
 * Density default and the Settings "use this for the board too" reset.
 */
import { useCallback, useEffect, useState } from 'react'
import { useA11yPrefs } from '../../../lib/a11y-prefs'
import type { SpecSortMode, SpecSortDir } from '../../specs/types/spec-sort'
import { loadSpecSort, saveSpecSort } from '../../specs/lib/spec-sort'
import {
  loadSpecsViewTier,
  hasStoredSpecsViewTier,
  saveSpecsViewTier,
  SPECS_VIEW_TIER_RESET_EVENT,
  type SpecsViewTier,
} from '../../specs/lib/specs-view-tier'

export function useBoardViewPrefs(activeProjectId: string | null) {
  const initialSort = loadSpecSort(activeProjectId)
  const [sortMode, setSortMode] = useState<SpecSortMode>(initialSort.mode)
  const [sortDir, setSortDir] = useState<SpecSortDir>(initialSort.dir)
  const [viewTier, setViewTier] = useState<SpecsViewTier>(() => loadSpecsViewTier(activeProjectId))

  // Reset sort and view tier when active project changes
  useEffect(() => {
    const s = loadSpecSort(activeProjectId)
    setSortMode(s.mode)
    setSortDir(s.dir)
    setViewTier(loadSpecsViewTier(activeProjectId))
  }, [activeProjectId])

  // The app Density setting is the default tier until the project (or a saved view) picks one.
  const appDensity = useA11yPrefs().density
  useEffect(() => {
    if (!hasStoredSpecsViewTier(activeProjectId)) setViewTier(loadSpecsViewTier(activeProjectId))
  }, [activeProjectId, appDensity])

  // Settings ▸ Density ▸ "Use this for the board too" drops this project's own tier.
  useEffect(() => {
    const onReset = (e: Event) => {
      const projectId = (e as CustomEvent<{ projectId?: string }>).detail?.projectId
      if (projectId === activeProjectId) setViewTier(loadSpecsViewTier(activeProjectId))
    }
    window.addEventListener(SPECS_VIEW_TIER_RESET_EVENT, onReset)
    return () => window.removeEventListener(SPECS_VIEW_TIER_RESET_EVENT, onReset)
  }, [activeProjectId])

  const handleSortChange = useCallback((mode: SpecSortMode, dir: SpecSortDir) => {
    setSortMode(mode)
    setSortDir(dir)
    saveSpecSort(activeProjectId, mode, dir)
  }, [activeProjectId])

  const handleViewTierChange = useCallback((tier: SpecsViewTier) => {
    setViewTier(tier)
    saveSpecsViewTier(activeProjectId, tier)
  }, [activeProjectId])

  /** A manual drag reorder leaves any sorted mode for the user's own order. */
  const resetSortAfterManualReorder = useCallback(() => {
    if (sortMode !== 'default') {
      setSortMode('default')
      saveSpecSort(activeProjectId, 'default', sortDir)
    }
  }, [sortMode, sortDir, activeProjectId])

  return { sortMode, sortDir, viewTier, handleSortChange, handleViewTierChange, resetSortAfterManualReorder }
}
