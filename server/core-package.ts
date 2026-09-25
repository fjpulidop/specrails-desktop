/** Core majors this Desktop can drive. Core 6 publishes integration contract
 * 5.0 (no standalone `update`); Cores 4 and 5 remain readable for installed
 * apps. The runtime resolver selects the newest usable compatible package and
 * never downgrades a newer activated framework. */
export const SUPPORTED_CORE_MAJORS: readonly number[] = [4, 5, 6]

export function isSupportedCoreVersion(version: string): boolean {
  return SUPPORTED_CORE_MAJORS.includes(Number(version.split('.')[0]))
}

/** Online fallback selects the Core 6 lifecycle, the same major the desktop bundles. */
export const CORE_PACKAGE_SPEC = 'specrails-core@^6.0.0'
