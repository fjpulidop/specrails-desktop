import config from './vitest.config'

// A shard collects partial coverage. Only the mandatory merge job evaluates
// the unchanged thresholds from vitest.config.ts against the complete corpus.
export default {
  ...config,
  test: { ...config.test, coverage: { ...config.test?.coverage, thresholds: undefined, reporter: [] } },
}
