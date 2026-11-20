// Public API of capacity (machine-wide run admission).
export { WAITING_FOR, admissionVerdict, defaultCapacityLimits, limitsFromEnv, admissionDisabled, type WaitingFor, type CapacityLimits, type AdmissionCandidate } from './domain'
export { createRunAdmission, AdmissionAbortedError, type RunAdmission, type QueueEvent, type QueuedRun, type ReleaseSlot } from './admission'
