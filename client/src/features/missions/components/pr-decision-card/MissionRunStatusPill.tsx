/**
 * The run-phase status pill of a PR decision card (running, paused, failed…)
 * in the status vocabulary: the state's glyph (the working lamp while the run
 * is active) and the card's own words for the phase.
 */
import { useTranslation } from 'react-i18next'
import { RunStatePill } from '../../../../components/ui/run-state/run-state-pill'
import { missionRunStatusState } from '../../lib/mission-run-state'
import type { MissionRunStatus } from './run-status'

export function MissionRunStatusPill({ status }: { status: MissionRunStatus }) {
  const { t } = useTranslation('agent')
  return (
    <RunStatePill
      data-testid="mission-run-status"
      data-status={status}
      state={missionRunStatusState(status)}
      label={t(`runCard.status.${status}`)}
    />
  )
}
