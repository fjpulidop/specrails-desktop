/** Online fallback selects the supported Core 5 lifecycle. Bundled Core 4 remains
 * readable for installed apps; the runtime resolver selects the newest usable
 * compatible package and never downgrades a newer activated framework. */
export const CORE_PACKAGE_SPEC = 'specrails-core@^5.0.0'
