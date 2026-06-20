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
    expect(acceptAnswer).toHaveBeenCalledWith('dev-1', 'ANSWER_SDP')
  })

  it('routes per-room offers/answers when two devices reconnect in one cycle (M14)', async () => {
    const { store, doFetch } = fakeMailbox()
    const makeOffer = vi.fn(async (room: string) => ({
      sdp: `OFFER_${room}`, secret: `sec_${room}`, hubName: 'Mac', hubInstanceId: 'inst-1',
    }))
    const acceptAnswer = vi.fn(async () => true)
    const r = new MobileSignalReconnect({
      signalBase: 'http://h/s.php', doFetch, rooms: () => ['dev-A', 'dev-B'], makeOffer, acceptAnswer,
    })
    store.set('dev-A:req', '1')
    store.set('dev-B:req', '1')
    await r.poll()
    // Each room gets its OWN offer (no clobber).
    expect(makeOffer).toHaveBeenCalledWith('dev-A')
    expect(makeOffer).toHaveBeenCalledWith('dev-B')
    expect(JSON.parse(store.get('dev-A:offer') ?? '{}')).toMatchObject({ sdp: 'OFFER_dev-A' })
    expect(JSON.parse(store.get('dev-B:offer') ?? '{}')).toMatchObject({ sdp: 'OFFER_dev-B' })
    // Answers route back to the correct room.
    store.set('dev-A:answer', JSON.stringify({ sdp: 'ANS_A' }))
    store.set('dev-B:answer', JSON.stringify({ sdp: 'ANS_B' }))
    await r.poll()
    expect(acceptAnswer).toHaveBeenCalledWith('dev-A', 'ANS_A')
    expect(acceptAnswer).toHaveBeenCalledWith('dev-B', 'ANS_B')
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
