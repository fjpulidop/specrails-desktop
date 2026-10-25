import type { SampleStatus } from '../lib/sample-model'

export const READY: SampleStatus = {
  catalog: [{ id: 'tic-tac-toe', name: 'tic-tac-toe', specCount: 3 }],
  sample: null,
  defaultParentDir: '/Users/me/Specrails Samples',
  launch: {
    ready: true,
    preset: { provider: 'claude', model: 'haiku', local: false, loopId: 'factory:sdd-quick-openspec', runCapUsd: 1 },
    localPreset: null,
    estimate: { minutes: [3, 5], usd: [0.3, 1] },
    runCapUsd: 1,
  },
}

export const WITH_SAMPLE: SampleStatus = {
  ...READY,
  sample: { sampleId: 'tic-tac-toe', projectId: 'sample-p', path: '/Users/me/Specrails Samples/tic-tac-toe', specIds: [11, 12, 13] },
}

export const NOT_READY: SampleStatus = {
  ...WITH_SAMPLE,
  launch: { ready: false, reason: 'no_provider', estimate: { minutes: [3, 5], usd: [0.3, 1] }, runCapUsd: 1 },
}

export const WITH_LOCAL: SampleStatus = {
  ...WITH_SAMPLE,
  launch: {
    ...(READY.launch as Extract<SampleStatus['launch'], { ready: true }>),
    localPreset: { provider: 'local-lan', model: 'qwen3-coder', local: true, loopId: 'factory:sdd-quick-openspec', runCapUsd: null },
  },
}
