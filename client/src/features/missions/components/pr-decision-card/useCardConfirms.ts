/**
 * The confirmation dialogs a PR decision card can open, reset whenever a
 * broadcast moves the envelope on (this surface or another one answered).
 */
import { useEffect, useState } from 'react'

export function useCardConfirms(decision: string, prUrl: string | null | undefined, prDeliveryId: string) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [confirmingDismiss, setConfirmingDismiss] = useState(false)
  const [confirmingDiscardLocal, setConfirmingDiscardLocal] = useState(false)
  const [confirmingMergeLocal, setConfirmingMergeLocal] = useState(false)
  const [confirmingNoChangesDone, setConfirmingNoChangesDone] = useState(false)
  const [confirmingRefine, setConfirmingRefine] = useState(false)
  const [confirmingRecoverAndRetry, setConfirmingRecoverAndRetry] = useState(false)
  // Refine runs the discard action under the hood: only the button the person pressed spins.
  const [refining, setRefining] = useState(false)

  // A broadcast moved the envelope on (this surface or the other one answered):
  // reconcile any local confirm state to the fresh decision.
  useEffect(() => {
    setConfirmingDiscard(false)
    setConfirmingDismiss(false)
    setConfirmingDiscardLocal(false)
    setConfirmingMergeLocal(false)
    setConfirmingNoChangesDone(false)
    setConfirmingRefine(false)
    setConfirmingRecoverAndRetry(false)
  }, [decision, prUrl, prDeliveryId])

  return {
    confirmingDiscard, setConfirmingDiscard,
    confirmingDismiss, setConfirmingDismiss,
    confirmingDiscardLocal, setConfirmingDiscardLocal,
    confirmingMergeLocal, setConfirmingMergeLocal,
    confirmingNoChangesDone, setConfirmingNoChangesDone,
    confirmingRefine, setConfirmingRefine,
    confirmingRecoverAndRetry, setConfirmingRecoverAndRetry,
    refining, setRefining,
  }
}
