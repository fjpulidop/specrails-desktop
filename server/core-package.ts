/** Online fallback selects the supported Core 5 lifecycle; 5.1.0 is the floor
 * because it quotes the command path in its Windows shell runner (OpenSpec init
 * from an install directory with spaces). The desktop bundles the same version.
 * Bundled Core 4 remains readable for installed apps; the runtime resolver
 * selects the newest usable compatible package and never downgrades a newer
 * activated framework. */
export const CORE_PACKAGE_SPEC = 'specrails-core@^5.1.0'
