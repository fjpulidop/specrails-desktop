import { afterEach, describe, expect, it } from 'vitest'
import {
  assertProcessAdmission,
  beginAppProcessQuiescence,
  beginProjectProcessQuiescence,
  captureProcessAdmission,
  openProjectProcessAdmission,
  resetProcessAdmissionForTests,
} from './process-admission'
import { spawnAiCli } from './util/cli-prompt'

afterEach(() => resetProcessAdmissionForTests())

describe('process admission', () => {
  it('invalidates an in-flight project continuation before teardown yields', () => {
    const lease = captureProcessAdmission('project-a')

    beginProjectProcessQuiescence('project-a')

    expect(lease.isCurrent()).toBe(false)
    expect(() => lease.assertCurrent()).toThrow(/closed for project project-a/)
    expect(() => assertProcessAdmission('project-a')).toThrow(/closed/)
    expect(() => assertProcessAdmission('project-b')).not.toThrow()
  })

  it('uses a new generation when a project context is hydrated again', () => {
    const stale = captureProcessAdmission('project-a')
    beginProjectProcessQuiescence('project-a')
    openProjectProcessAdmission('project-a')

    expect(stale.isCurrent()).toBe(false)
    expect(captureProcessAdmission('project-a').isCurrent()).toBe(true)
  })

  it('closes every project and generic process spawn during app shutdown', () => {
    const generic = captureProcessAdmission()
    const project = captureProcessAdmission('project-a')

    beginAppProcessQuiescence()

    expect(generic.isCurrent()).toBe(false)
    expect(project.isCurrent()).toBe(false)
    expect(() => assertProcessAdmission()).toThrow(/application shutdown/)
    expect(() => assertProcessAdmission('project-b')).toThrow(/closed/)
    expect(() => spawnAiCli('definitely-not-a-real-binary', [])).toThrow(/application shutdown/)
  })
})
