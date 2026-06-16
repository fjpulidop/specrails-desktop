import { describe, it, expect, vi } from 'vitest'
import { MobileSignalReconnect } from './mobile-signal-reconnect'

// Simulates companion-signal.php: a key/value mailbox with one-shot GET (read
// deletes), keyed by room+slot.
function fakeMailbox() {
  const store = new Map<string, string>()
  const doFetch = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url)
    const key = `${u.searchParams.get('room')}:${u.searchParams.get('slot')}`
    if (init?.method === 'POST') {
      store.set(key, init.body ?? '')
      return { status: 204, text: async () => '' }
    }
    if (store.has(key)) {
      const v = store.get(key) ?? ''
      store.delete(key)
      return { status: 200, text: async () => v }
    }
    return { status: 204, text: async () => '' }
  }
  return { store, doFetch }
}

describe('MobileSignalReconnect', () => {
  it('answers a reconnect request with a fresh offer, then applies the answer', async () => {
    const { store, doFetch } = fakeMailbox()
    const makeOffer = vi.fn(async () => ({ sdp: 'OFFER_SDP', secret: 's1', hubName: 'Mac', hubInstanceId: 'inst-1' }))
    const acceptAnswer = vi.fn(async () => true)
    const r = new MobileSignalReconnect({
      signalBase: 'http://h/companion-signal.php',
      doFetch,
      rooms: () => ['dev-1'],
      makeOffer,
      acceptAnswer,
    })

    store.set('dev-1:req', '1') // phone asks to reconnect
    await r.poll()
    expect(makeOffer).toHaveBeenCalledOnce()
    expect(JSON.parse(store.get('dev-1:offer') ?? '{}')).toMatchObject({
      sdp: 'OFFER_SDP',
      sec: 's1',
      hub: 'inst-1',
      name: 'Mac',
    })

    store.set('dev-1:answer', JSON.stringify({ sdp: 'ANSWER_SDP' })) // phone answers
    await r.poll()
    expect(acceptAnswer).toHaveBeenCalledWith('ANSWER_SDP')
  })

  it('does nothing when the mailbox is empty', async () => {
    const { doFetch } = fakeMailbox()
    const makeOffer = vi.fn(async () => null)
    const acceptAnswer = vi.fn(async () => false)
    const r = new MobileSignalReconnect({ signalBase: 'http://h/s.php', doFetch, rooms: () => ['dev-1'], makeOffer, acceptAnswer })
    await r.poll()
    expect(makeOffer).not.toHaveBeenCalled()
    expect(acceptAnswer).not.toHaveBeenCalled()
  })
})
