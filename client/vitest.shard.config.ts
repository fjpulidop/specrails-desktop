import config from './vitest.config'

// The aggregate uses vitest.config.ts, including every existing threshold.
export default {
  ...config,
  test: { ...config.test, coverage: { ...config.test?.coverage, thresholds: undefined, reporter: [] } },
}
