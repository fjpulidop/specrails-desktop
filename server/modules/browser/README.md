# browser

This module owns the browser capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/browser-capture-manager.ts](runtime/browser-capture-manager.ts)
- [runtime/browser-capture-types.ts](runtime/browser-capture-types.ts)
- [runtime/browser-context-pool.ts](runtime/browser-context-pool.ts)
- [runtime/browser-playwright.ts](runtime/browser-playwright.ts)
- [runtime/preview-targets.ts](runtime/preview-targets.ts)
- [domain/preview-origins.ts](domain/preview-origins.ts)

## Companion app preview

A paired Companion can view a project's locally served web app through a
**device-owned** session of this manager (`owner: { kind: 'device' }`).
Device sessions differ from Desktop sessions in three ways:

- **Budget.** They do not count against the 4 Desktop sessions per project.
  Each device holds one session (opening another replaces it), and a project
  holds at most two device sessions.
- **Origin pinning.** The pure policy in `domain/preview-origins.ts` allows a
  loopback origin only while a running mission background process of the
  project announces it in its logs (`runtime/preview-targets.ts`). Specrails'
  own ports (Desktop API, mobile gateway) are never targets, whatever a process
  prints. Everything else falls back to `isNavigableUrl`. A page-scoped request
  guard (`setRequestGuard`) enforces it for documents, subresources, popups and
  direct `goto` navigations, and creation fails closed without it. Desktop pages
  carry no guard and keep the unchanged SSRF rule.
- **Manual URLs.** `navigateAsDevice` accepts only paths on announced origins.

The gateway side (channels, routes, capability) lives in `server/mobile/mobile-preview*.ts`.

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/browser` and any affected consumers.
