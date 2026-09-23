import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { projectSupportsProfiles, buildTelemetryEnv } from './modules/execution/runtime/queue-manager'

let projectPath: string

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-support-'))
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('projectSupportsProfiles', () => {
  it('returns false when .specrails/specrails-version is missing', () => {
    expect(projectSupportsProfiles(projectPath)).toBe(false)
  })

  it('returns false when version is older than 4.1.0', () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), '4.0.8')
    expect(projectSupportsProfiles(projectPath)).toBe(false)
  })

  it('returns true for 4.1.0 exactly', () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), '4.1.0')
    expect(projectSupportsProfiles(projectPath)).toBe(true)
  })

  it('returns true for 4.2.x', () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), '4.2.3')
    expect(projectSupportsProfiles(projectPath)).toBe(true)
  })

  it('returns true for 5.x', () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), '5.0.0')
    expect(projectSupportsProfiles(projectPath)).toBe(true)
  })

  it('falls back to legacy .specrails-version location', () => {
    fs.writeFileSync(path.join(projectPath, '.specrails-version'), '4.1.0')
    expect(projectSupportsProfiles(projectPath)).toBe(true)
  })

  it('returns false on unparseable version strings', () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), 'banana')
    expect(projectSupportsProfiles(projectPath)).toBe(false)
  })
})

describe('buildTelemetryEnv', () => {
  it('emits base resource attributes when no extras are provided', () => {
    const env = buildTelemetryEnv('job-1', 'project-a', 4200)
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'specrails.job_id=job-1,specrails.project_id=project-a',
    )
  })

  it('appends profile resource attributes when provided', () => {
    const env = buildTelemetryEnv('job-1', 'project-a', 4200, {
      'specrails.profile_name': 'data-heavy',
      'specrails.profile_schema_version': '1',
    })
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('specrails.profile_name=data-heavy')
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('specrails.profile_schema_version=1')
    expect(env.OTEL_RESOURCE_ATTRIBUTES.startsWith('specrails.job_id=')).toBe(true)
  })
})
