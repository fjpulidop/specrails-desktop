/**
 * Delivery change observers: capabilities that follow a delivery (an offer card, for example) subscribe
 * here at composition time instead of delivery importing them. Called after every delivery state emit;
 * an observer must not throw or block (it is advisory).
 */
import type { ProjectContext } from '../../../project-registry'

export type DeliveryObserver = (ctx: ProjectContext, deliveryId: string) => void

const observers = new Set<DeliveryObserver>()

/** Subscribes; returns the unsubscribe function. */
export function observeDeliveries(observer: DeliveryObserver): () => void {
  observers.add(observer)
  return () => { observers.delete(observer) }
}

export function notifyDeliveryObservers(ctx: ProjectContext, deliveryId: string): void {
  for (const observer of observers) {
    try { observer(ctx, deliveryId) } catch (err) { console.error('[delivery] observer failed:', err) }
  }
}
