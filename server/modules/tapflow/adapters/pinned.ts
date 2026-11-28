/**
 * The whole dependency tree Specrails installs, pinned: Tapflow's own packages are exact (TAPFLOW_VERSION),
 * but its ~190 third-party dependencies would resolve afresh on every install and could change under us.
 * The installer writes these two files and runs `npm ci`, which installs exactly this tree and checks every
 * package's integrity hash. Tapflow changes only when we bump TAPFLOW_VERSION and regenerate the lockfile
 * (README: "Updating Tapflow"); Tapflow itself never updates at runtime.
 */
import pinnedManifest from '../pinned/package.json'
import pinnedLockfile from '../pinned/package-lock.json'

export const TAPFLOW_PINNED_FILES = { 'package.json': pinnedManifest, 'package-lock.json': pinnedLockfile } as const
