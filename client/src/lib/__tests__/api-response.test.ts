import { describe, expect, it } from 'vitest'
import { parseApiJson, readApiJson } from '../api-response'
import i18n, { loadLanguage } from '../i18n'

describe('API response decoding', () => {
  it.each(['<!DOCTYPE html><title>Private document</title>', '  <html>Other app</html>', '{"incomplete":'])('reports malformed responses without leaking body contents: %s', async (body) => {
    await expect(readApiJson(new Response(body))).rejects.toMatchObject({ name: 'ApiResponseError' })
  })

  it('rejects a declared HTML page even when its body resembles JSON', async () => {
    await expect(parseApiJson(new Response('{"accepted":true}', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))).rejects.toMatchObject({ code: 'htmlResponse' })
  })

  it('allows empty successful mutation responses and JSON without a content-type', async () => {
    expect(await readApiJson(new Response(null, { status: 204 }))).toBeNull()
    expect(await readApiJson(new Response('{"ok":true}'))).toEqual({ ok: true })
  })

  it('preserves explicit API errors and provides meaningful empty/error fallback messages', async () => {
    await expect(readApiJson(new Response('{"error":"Permission denied"}', { status: 403 }))).rejects.toThrow('Permission denied')
    await expect(readApiJson(new Response('', { status: 502 }))).rejects.toThrow('HTTP 502')
    await expect(readApiJson(new Response('{"error":"api_route_not_found"}', { status: 404 }))).rejects.toThrow('versions match')
  })

  it('uses the current UI language for a wrong backend response', async () => {
    await loadLanguage('es')
    await i18n.changeLanguage('es')
    try {
      await expect(readApiJson(new Response('<!DOCTYPE html>'))).rejects.toThrow('La API devolvió una página web')
    } finally { await i18n.changeLanguage('en') }
  })
})
