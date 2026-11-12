import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'
import en from '../../../locales/en/builder.json'
import es from '../../../locales/es/builder.json'
import { formatMilestoneToast, type FormatMilestoneToastInput, type MilestoneToastEvent } from './milestone-toast'

const input: FormatMilestoneToastInput = {
  projectName: 'specrails', milestoneLabel: 'M1', event: 'chunk_launched', status: 'running',
  startedAt: '2026-09-04T10:00:00.000Z', endedAt: '2026-09-04T12:05:00.000Z',
  now: Date.parse('2026-09-04T10:38:00.000Z'), railProgress: { current: 4, total: 8 }, reviewCount: 8,
}

async function translator(lng = 'en') {
  const instance = createInstance()
  await instance.init({ lng, resources: { en: { builder: en }, es: { builder: es } }, interpolation: { escapeValue: false } })
  return (key: string, params?: Record<string, unknown>) => String(instance.t(key, params))
}

describe('formatMilestoneToast', () => {
  it.each<[string, MilestoneToastEvent, string, string]>([
    ['en', 'chunk_launched', 'rail 4 of 8 launched', 'Running · 38m total'],
    ['en', 'checkpoint', 'rail 4 of 8 delivered. Launch the next rail?', 'Awaiting approval · 38m total'],
    ['en', 'paused', 'paused — provider limit', 'Paused · 38m total'],
    ['en', 'delivered', 'delivered — 8 specs waiting for your review', 'Delivered — awaiting review · 2h 05m total'],
    ['en', 'completed', 'complete — every spec merged', 'Completed in 2h 05m'],
    ['es', 'chunk_launched', 'rail 4 de 8 lanzado', 'En marcha · 38m en total'],
    ['es', 'checkpoint', 'rail 4 de 8 entregado. ¿Lanzar el siguiente rail?', 'Esperando aprobación · 38m en total'],
    ['es', 'paused', 'en pausa — límite del proveedor', 'En pausa · 38m en total'],
    ['es', 'delivered', 'entregado — 8 specs esperan tu revisión', 'Entregado — pendiente de revisión · 2h 05m en total'],
    ['es', 'completed', 'completado — todas las specs integradas', 'Completado en 2h 05m'],
  ])('[spec:milestone-launch-chain/unified-milestone-notification-content] [spec:milestone-launch-chain/milestone-notification-localization-parity] %s %s retains event detail and shares the two-line layout', async (lng, event, body, description) => {
    const t = await translator(lng)
    expect(formatMilestoneToast({ ...input, event, pauseReason: lng === 'es' ? 'límite del proveedor' : 'provider limit' }, t)).toEqual({ title: `specrails · M1 — ${body}`, description })
  })

  it.each([null, '', '   '])('[spec:milestone-launch-chain/notification-context-degrades-safely] omits absent project %s', async (projectName) => {
    expect(formatMilestoneToast({ ...input, projectName }, await translator())).toEqual({ title: 'M1 — rail 4 of 8 launched', description: 'Running · 38m total' })
  })

  it.each([null, '', 'invalid'])('[spec:milestone-launch-chain/notification-context-degrades-safely] omits unavailable start %s', async (startedAt) => {
    expect(formatMilestoneToast({ ...input, startedAt }, await translator())).toEqual({ title: 'specrails · M1 — rail 4 of 8 launched', description: 'Running' })
  })

  it('clamps a future active start to zero', async () => {
    expect(formatMilestoneToast({ ...input, startedAt: '2026-09-05T10:00:00.000Z' }, await translator()).description).toBe('Running · 0s total')
  })

  it.each<MilestoneToastEvent>(['delivered', 'completed'])('[spec:milestone-launch-chain/static-total-milestone-elapsed-time] %s freezes the end regardless of receipt time', async (event) => {
    const t = await translator()
    const result = formatMilestoneToast({ ...input, event }, t)
    expect(result).toEqual(formatMilestoneToast({ ...input, event, now: input.now + 86_400_000 }, t))
    expect(result.description).toContain('2h 05m')
  })

  it.each<[MilestoneToastEvent, string | null, string]>([
    ['delivered', null, 'Delivered — awaiting review'], ['delivered', 'invalid', 'Delivered — awaiting review'],
    ['completed', null, 'Completed'], ['completed', 'invalid', 'Completed'],
    ['delivered', '2026-09-04T09:00:00.000Z', 'Delivered — awaiting review · 0s total'],
    ['completed', '2026-09-04T09:00:00.000Z', 'Completed in 0s'],
  ])('[spec:milestone-launch-chain/notification-context-degrades-safely] %s handles end %s', async (event, endedAt, description) => {
    expect(formatMilestoneToast({ ...input, event, endedAt }, await translator()).description).toBe(description)
  })

  it.each<[MilestoneToastEvent, string]>([
    ['chunk_launched', 'rail launched'], ['checkpoint', 'rail delivered. Launch the next rail?'],
    ['paused', 'paused'], ['delivered', 'delivered'], ['completed', 'complete — every spec merged'],
  ])('[spec:milestone-launch-chain/notification-context-degrades-safely] %s never interpolates missing event context', async (event, body) => {
    const result = formatMilestoneToast({ ...input, event, projectName: null, startedAt: null, railProgress: undefined, reviewCount: undefined, pauseReason: '' }, await translator())
    expect(result.title).toBe(`M1 — ${body}`)
    expect(JSON.stringify(result)).not.toMatch(/undefined|NaN|·\s*$|—\s*$/)
  })
})
