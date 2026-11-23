---
paths:
  - "client/**"
---

# Client Conventions

## Stack

- React 18 + TypeScript + Vite + Tailwind v4
- ESM modules (`client/tsconfig.json` — separate from root `tsconfig.json`)
- File naming: PascalCase for components (e.g., `DashboardPage.tsx`, `JobDetailModal.tsx`), kebab-case for utilities
- Run `cd client && npm install` separately — client has its own `package.json`

## API calls

- **ALWAYS use `getApiBase()`** from `lib/api.ts` as the prefix for all API calls
  - Wrong: `fetch('/api/projects/123/jobs')`
  - Right: `fetch(\`${getApiBase()}/jobs\`)`
- `getApiBase()` returns `/api/projects/<id>` for the active project (throws when no project is set)
- `DesktopProvider` updates this when the active project changes — never cache the base URL

## State management

- **Never use module-level caches** that could bleed between projects (e.g., no `let cache = {}` at module scope in hooks)
- Use `useProjectCache` for stale-while-revalidate per-project data caching
- Per-project state: always include `activeProjectId` as a `useEffect` dependency

## WebSocket

- **Filter by `activeProjectId` using a ref, not state** — prevents stale closure bugs
  ```tsx
  const activeProjectIdRef = useRef(activeProjectId);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  // In WS handler:
  if (msg.projectId !== activeProjectIdRef.current) return;
  ```
- App-level WS messages have no `projectId` — they reach all handlers (e.g., `desktop.project_added`)

## Super mode

- `App.tsx` mounts `DesktopProvider` and `DesktopApp` unconditionally (Super mode is the only mode; `GET /api/state` reports `mode: 'super'`)
- `useDesktop.tsx` — `DesktopProvider` context: project list and active project
- `useProjectRouteMemory` — saves/restores URL route per project on tab switch
- On project switch: show cached data immediately, fetch fresh data in background — never reset to empty state

## Tailwind v4

- Use `@import "tailwindcss"` syntax (v4 style)
- Class-based styling only — no inline styles for layout/spacing
- Dark mode via `dark:` prefix

## Component patterns

- Radix UI primitives for accessible components (Dialog, Dropdown, Tabs, etc.)
- Recharts for data visualization — already installed, no new charting libs
- `.map()` in JSX always requires a `key` prop
- Interactive `<div>` elements need `role` and `tabIndex` for accessibility

## Build

- TypeScript check: `cd client && npx tsc --noEmit`
- Build: `cd client && npm run build` (runs tsc + vite build)
- Dev server: runs on port 4201, proxies `/api` and `/hooks` to port 4200
