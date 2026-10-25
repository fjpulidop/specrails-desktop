import { TOUR_LOG_LINE_INTERVAL_MS, type TourLogLine } from '../../../demo-mode/fixtures/tour-log'

/**
 * The bundled RECORDING of a finished sample run, replayed when no AI provider
 * is ready. It reuses the demo-mode log vocabulary (marker + timestamp + text)
 * and pacing; the text is looked up in the `onboarding` namespace by `key`.
 * Nothing here runs or bills anything, and the UI says so.
 */
export interface RecordedLine extends Omit<TourLogLine, 'text'> {
  key: string
}

export const RECORDED_LINES: readonly RecordedLine[] = [
  { id: 1, timestamp: '10:02:11', marker: '✓', key: 'setup' },
  { id: 2, timestamp: '10:02:48', marker: '→', key: 'specPhase' },
  { id: 3, timestamp: '10:03:20', marker: '✓', key: 'specDone' },
  { id: 4, timestamp: '10:03:31', marker: '→', key: 'implementPhase' },
  { id: 5, timestamp: '10:04:42', marker: '✓', key: 'implementDone' },
  { id: 6, timestamp: '10:04:55', marker: '→', key: 'testPhase' },
  { id: 7, timestamp: '10:05:30', marker: '✓', key: 'testDone' },
  { id: 8, timestamp: '10:05:41', marker: '→', key: 'reviewPhase' },
  { id: 9, timestamp: '10:06:09', marker: '✓', key: 'shipped' },
]

export const RECORDED_LINE_INTERVAL_MS = TOUR_LOG_LINE_INTERVAL_MS

/** What the recorded run's Review packet shows (numbers are part of the recording). */
export const RECORDED_PACKET = {
  files: [
    { path: 'game.js', added: 14, removed: 2 },
    { path: 'logic.js', added: 4, removed: 0 },
    { path: 'logic.test.js', added: 9, removed: 0 },
    { path: 'index.html', added: 1, removed: 0 },
  ],
  tests: 5,
  confidence: 91,
} as const
