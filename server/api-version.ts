import type { NextFunction, Request, Response } from 'express'

/**
 * Version of the local HTTP API contract (`/api/**`).
 *
 * Bump ONLY on a breaking change (a removed route or field, or a changed
 * meaning). Additive changes keep the version. Deprecated routes/fields are
 * announced in CHANGELOG under "Deprecations" and kept for at least two minor
 * releases — see docs/internals/api-reference.md#versioning-and-deprecation-policy.
 */
export const API_VERSION = 1
export const API_VERSION_HEADER = 'X-Specrails-Api-Version'

/** Stamps every `/api` response (including errors and auth rejections). */
export function apiVersionHeader(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(API_VERSION_HEADER, String(API_VERSION))
  next()
}
