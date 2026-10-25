import type { Router } from 'express'
import { createSample, currentSample, defaultSampleParent, removeSample, type SampleDeps } from '../application'
import {
  SAMPLE_ESTIMATE, SAMPLE_RUN_CAP_USD, SampleError, chooseSamplePreset, normalizeSampleLocale,
  type PresetProviderCandidate, type SampleLaunchReadiness,
} from '../domain'

export interface OnboardingRouteDeps extends SampleDeps {
  /** Providers as the preset chooser sees them (detection snapshot, models, prices). */
  providers: (opts: { refresh: boolean }) => Promise<PresetProviderCandidate[]>
}

function sendError(res: import('express').Response, err: unknown): void {
  if (err instanceof SampleError) { res.status(err.status).json({ error: err.code, detail: err.message }); return }
  console.error('[onboarding] sample error:', err)
  res.status(500).json({ error: 'sample_failed', detail: 'Unexpected error while handling the sample project' })
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 ? value.trim() : undefined
}

/**
 * Sample-project first run, mounted on the app-level `/api` router:
 *   GET    /api/onboarding/sample   catalog, current sample, default folder and launch readiness
 *   POST   /api/onboarding/sample   create (idempotent) + register the sample project
 *   DELETE /api/onboarding/sample   unregister it; `?deleteFolder=1` also deletes the folder
 * The run itself uses the ordinary rail launch route with the preset returned here.
 */
export function registerOnboardingRoutes(router: Router, deps: OnboardingRouteDeps): void {
  router.get('/onboarding/sample', async (req, res) => {
    try {
      const refresh = req.query.refresh === '1'
      let readiness: SampleLaunchReadiness
      try {
        readiness = chooseSamplePreset(await deps.providers({ refresh }))
      } catch (err) {
        // Detection failing is "not ready" (the recorded run is offered), never a 500.
        console.warn('[onboarding] provider readiness failed:', err)
        readiness = { ready: false, reason: 'no_provider', preset: null, localPreset: null }
      }
      const current = currentSample(deps)
      res.json({
        catalog: deps.samples.map((sample) => ({ id: sample.id, name: sample.name, specCount: sample.specs.length })),
        sample: current ? { sampleId: current.record.sampleId, projectId: current.record.projectId, path: current.record.path, specIds: current.record.specIds } : null,
        defaultParentDir: defaultSampleParent(deps.files),
        launch: { ...readiness, estimate: SAMPLE_ESTIMATE, runCapUsd: SAMPLE_RUN_CAP_USD },
      })
    } catch (err) { sendError(res, err) }
  })

  router.post('/onboarding/sample', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const result = await createSample(deps, {
        sampleId: text(body.sampleId) ?? deps.samples[0]?.id ?? '',
        locale: normalizeSampleLocale(body.locale),
        targetPath: text(body.path),
        parentDir: text(body.parentDir),
      })
      res.status(result.reused ? 200 : 201).json({
        reused: result.reused,
        project: { id: result.project.id, name: result.project.name, path: result.project.path },
        sample: { sampleId: result.record.sampleId, projectId: result.record.projectId, path: result.record.path, specIds: result.record.specIds },
      })
    } catch (err) { sendError(res, err) }
  })

  router.delete('/onboarding/sample', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const result = removeSample(deps, { deleteFolder: req.query.deleteFolder === '1' || body.deleteFolder === true })
      res.json({ ok: true, ...result })
    } catch (err) { sendError(res, err) }
  })
}
