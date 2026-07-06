# Specrails Desktop — Design Synthesis (Visual System · Mechanical Fixes · Rails Redesign)

Verified against working tree: `client/package.json` has no animate plugin; `globals.css:64` = `--radius: 0.75rem`; `RailRow.tsx:289` shadow uses undefined `--accent-info`; `glow-*` utilities exist at `globals.css:345-350`; 175 `aurora-light:` dual-class sites.

---

# PART 1 — VISUAL SYSTEM

The canon below is the **majority-existing code**, promoted to law. Reference implementations: **AnalyticsPage** (layout/cards/type), **agent-chat family** (motion/glass/tokens), **Add Spec + StatusBar** (token hygiene). Nothing here invents a new aesthetic; it deletes the two losing dialects (raw-palette+`aurora-light:` forks, dracula literals) and keeps the winning one.

## 1.1 Color: one token dialect
- **Only semantic tokens.** `accent-primary` (brand/AI/specs) · `accent-secondary` (rails) · `accent-info` (running/live/links/inline-code) · `accent-success` (done/go) · `accent-warning` (cost/caution) · `accent-highlight` (explore) · `destructive` (error/delete) · `muted`/`muted-foreground` (inactive). The 175-site `text-blue-400 aurora-light:text-accent-info` idiom collapses to the token alone — the token is already themed for all five themes.
- **Text on accent backgrounds = `text-background`** (the `SetupWizard.tsx:550` pattern), never `text-white`. On `bg-primary`/`bg-destructive` use their `-foreground` pair.
- **Glows** only via the existing utilities `glow-primary/-secondary/-info/-success/-warning/-highlight` (`globals.css:345-350`) or the `color-mix(in srgb, var(--color-accent-*) N%, transparent)` form. `hsl(var(--accent-*)/N)` is INVALID (tokens are `--color-*` holding complete `hsl()` values) — it silently renders nothing.
- **Status mapping (frozen):** running = `accent-info` + `Loader2` spin · success = `accent-success` + `CheckCircle2` · failed = `destructive` + `XCircle` · canceled/queued = `muted` + `Ban` · warning/cost = `accent-warning` + `AlertTriangle`/`DollarSign`.
- **Priority canon** (the ProposeSpecModal set — the only fully tokenized one): critical=`destructive`, high=`accent-warning`, medium=`accent-info`, low=`muted`.
- **Left sidebar title = accent-primary, right sidebars = accent-secondary** (existing rule; document, keep).

## 1.2 Icon scale (lucide, `w-N h-N` pair idiom — never `size={}` props)
| Context | Size | Margin |
|---|---|---|
| Nav rows, page/dialog headers, icon-buttons ≥ h-8, palette rows | `w-4 h-4` | `mr-2` |
| Dense rows, `size="sm"` button leading icons, toolbars, settings headings | `w-3.5 h-3.5` | `mr-1.5` |
| Chips/badges/breadcrumbs/`h-7` buttons/select chevrons (ui/select `w-3` is the codified convention) | `w-3 h-3` | `mr-1` |
| Micro close/status inside pills & tab strips | `w-2.5 h-2.5` | — |
| Step/hero icons | `w-6 h-6` | — |
| Page-level empty-state pictograms (`w-6` for narrow panels) | `w-8 h-8` | — |
Chevron next to a row icon = one tier below the row icon. Stroke = lucide default 2 (exceptions: TitleBar window controls, PanelChevronButton). **No emoji, no text glyphs (`×`, `↺`, `✓`, `+`) where a lucide icon exists** — `kbd` glyphs (`⌘⇧↵`) exempt.

## 1.3 Lines, radius, shadow (three-stop border system)
Prereq: delete/rename `--radius: 0.75rem` (`globals.css:64`) so bare `rounded` stops meaning 12px; raise `[data-theme="specrails"] --color-border` from `/0.11` to `~/0.16` for modifier headroom. Sanctioned opacity stops: **full, `/60`, `/40`, `/50` (cards only)**. Kill list: `/10 /20 /25 /70`, `shadow-black/*`, raw `rgba()`/`hsl()` shadow literals, bare `border` without color, `ring-1 ring-border` as pseudo-border.
| Tier | Recipe |
|---|---|
| App-frame chrome hairline (sidebars, title/status bar, pane splits, board headers) | `border-border` (full — the token IS the hairline) |
| Inset divider (rows inside cards/modals, `divide-*`) | `border-border/40` |
| Page block card | `rounded-xl border border-border/50 bg-card/40 p-4` (hero: `p-5 bg-gradient-to-br from-card/80 to-card/40`) |
| Row card | `rounded-lg border-border/40 bg-card/60 hover:border-border/60` |
| Menu/popover | `rounded-lg border-border/60 bg-popover/95 backdrop-blur-md shadow-xl` |
| Tooltip | `rounded-md border-border shadow-md` (as-is) |
| Centered modal | `rounded-xl border-border/40 bg-popover shadow-2xl backdrop-blur-md` |
| Floating glass (agent bubble/panel, dock) | `rounded-2xl border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl` |
| Form controls | `rounded-md` (input/button/select trigger all match) |
| Focus | `focus-visible:ring-2 focus-visible:ring-ring` everywhere |
| Scrims | standard `bg-black/60 backdrop-blur-sm`; immersive (lightbox/onboarding) `bg-black/80 backdrop-blur-md` |

## 1.4 Motion vocabulary
Prereq (fix #1): `npm i tw-animate-css` + `@import "tw-animate-css";` in `globals.css` — resurrects the ~22 authored-but-dead `animate-in/out` surfaces.
- **150ms micro** — hover colors, opacity, chevron rotate, overlay fades. Bare `transition-colors` (default duration).
- **200ms structural-small** — modal/popover/tooltip enter: `animate-in fade-in-0 zoom-in-95 duration-200`, exit via `data-[state=closed]:animate-out`.
- **250–300ms structural-large** — panel slides (terminal, sidebars), height disclosures (`grid-template-rows 0fr→1fr` trick), `ease-out`.
- **400–500ms ambient** — progress bars, status frames only.
- **Easings:** enters `ease-out`; house arrival overshoot `cubic-bezier(0.34,1.56,0.64,1)` registered once as `--ease-arrive` in `@theme`, reserved for floating-object arrival (chat panel, chips, swipe snap-back); springs `stiffness 350–420 / damping 28–34` for layout morphs (AgentModeSurface/AgentBubble values).
- **Morph vs fade:** `layoutId` spring when the SAME object persists (chip⇄panel, tab underline, kanban cross-column); fade+zoom for transient surfaces. Never `transition-all` on size-changing containers (use `transition-[width]` etc.).
- **Reduced motion:** one `<MotionConfig reducedMotion="user">` at app root; `motion-safe:` on decorative loops; global `prefers-reduced-motion` clamp in `globals.css` with `.motion-keep` escape for spinners.

## 1.5 Spacing & type rhythm
- Page gutter `px-6`; scrolling pages `py-6`; full-height pages: header `px-6 pt-4 pb-3 border-b border-border`.
- Three container archetypes: **workspace** full-bleed (Dashboard, Code, LoopBuilder) · **data page** `max-w-6xl mx-auto w-full` (Analytics, Jobs, JobDetail, Loops) · **reading/forms** `max-w-3xl` (Settings, Docs).
- Section gap `gap-6`/`space-y-6`; heading→content `space-y-2`.
- Two sanctioned header voices: **page header** `h1 text-lg font-semibold` + `text-xs text-muted-foreground mt-0.5` subtitle; **workspace pane header** `px-4 h-12 border-b border-border/40` + `text-sm font-semibold` tinted h2 (SpecsBoard/RailsBoard form). No third variant.
- Type scale: kicker `text-xs font-semibold uppercase tracking-wider text-muted-foreground` · card title `text-sm font-semibold` · body `text-sm` · metadata `text-xs` · dense-chrome floor `text-[11px]` · badge floor `text-[10px]` (**`text-[9px]` banned**) · display numbers `text-5xl font-semibold tabular-nums tracking-tight`, heroes only.
- Contrast floor: never below `text-muted-foreground/50` under 12px. Interactive elements never below `text-[11px]`, native form controls never below `h-7 text-xs`.
- One shared `<EmptyState icon title description action?>` (RecentJobs pattern: dashed card, `w-8 h-8 opacity-20` icon, `text-sm font-medium` title, `text-xs text-muted-foreground/60` hint, `py-12`).

## 1.6 Concept → icon + accent (canonical)
| Concept | Icon | Accent |
|---|---|---|
| Spec/ticket entity | `Ticket` | accent-primary |
| Rails / execution lane | `Layers` (exclusive — epic filter → `FolderTree`, batch → `ListChecks`) | accent-secondary |
| Job | `Briefcase` | accent-info |
| Job running / in-flight action | `Loader2` spin | accent-info |
| Job success | `CheckCircle2` | accent-success |
| Job failed | `XCircle` | destructive |
| Job canceled | `Ban` | muted-foreground |
| App agent (chat/mode) | `Bot` | accent-primary |
| Pipeline agents/profiles | `BrainCircuit` | accent-primary |
| MCP | `Plug` | accent-info |
| AI generate/magic | `Sparkles` | accent-primary (one tint) |
| Explore | `MessagesSquare` | accent-highlight |
| Quick spec | `Zap` | accent-secondary |
| Sidebar chat / comments | `MessageSquare` / `MessageSquareText` | accent-primary |
| Project analytics / Desktop analytics | `BarChart3` / `PieChart` | neutral |
| Docs / Code / Terminal / Loops | `BookOpen` / `Code2` / `Terminal` / `Workflow` | neutral |
| Cost | `DollarSign` | accent-warning |
| Refresh data / retry op / browser reload | `RefreshCw` / `RotateCcw` / `RotateCw` | — |
| Send | `Send w-3.5` | — |
| Provider | `Cpu` (kill the `🤖⚡✨` emoji) | neutral |

**Regression guards (CI grep-deny, extends the existing `dracula-*` guard):** `aurora-light:` outside globals.css · `#50fa7b|#ff5555|#f1fa8c|#6272a4|#44475a|rgba\(139,233|rgba\(189,147` · `text-white` on `bg-accent`/`bg-emerald`/`bg-green` lines · `hsl\(var\(--` · `border-border/(10|20|25|70)` · `shadow-black/` · `text-\[9px\]` · bare `rounded[" ]` (post-codemod).

---

# PART 2 — MECHANICAL FIX LIST (top 40, deduplicated, ranked by visibility)

1. `client/package.json` + `client/src/globals.css:2` — missing animate plugin → `npm i tw-animate-css` + `@import "tw-animate-css";`. Single change lights up ~22 dead surfaces (dialog.tsx:31/75/98, select.tsx:66, tooltip.tsx:17, TicketDetailModal:338, ExploreSpecShell:768, JobDetailModal:190, lightbox, AiEditShell:179, ProposeSpecModal:451, SmashConfirmModal:73, OnboardingWizard:725/732). Highest ROI line in the entire audit.
2. `client/src/globals.css:64` — `--radius: 0.75rem;` → delete (nothing consumes it; it hijacks bare `rounded` to 12px, inverting the radius scale at 254 sites). Follow with codemod: bare `rounded` → `rounded-sm` (chips/kbd) / `rounded-md` (controls).
3. `components/ui/badge.tsx:14-20` — raw `bg-emerald-500/20 … aurora-light:*` pairs → semantic alone: `success: bg-accent-success/15 text-accent-success border-accent-success/30`, `running: …accent-info…`, `warning: …accent-warning…`, `failed: …destructive…`, `queued/canceled: bg-muted text-muted-foreground border-border`. The shared status primitive — every job/status chip inherits.
4. `components/RailRow.tsx:289,310,312,530` — invalid `shadow-[…hsl(var(--accent-info)/0.35)…]` (never rendered) → `glow-info` utility or `color-mix(in_srgb,var(--color-accent-info)_35%,transparent)` form; `:554` delete the duplicate hardcoded dot `bg-emerald-400 shadow-[0_0_4px_hsl(142_70%_56%/0.8)]` → `bg-accent-success` + fixed :310 shadow.
5. `components/CommandGrid.tsx:32-86` — dracula rgba glow literals → `hover:glow-info hover:border-accent-info/50` (map per card accent); `:225/:227` — `Zap w-3.5` → `w-4 h-4` to match sibling ArrowRight.
6. `components/ProjectHealthWidget.tsx:51,92,110-124,141` + `components/HealthIndicatorBadge.tsx:28-31` — `#50fa7b/#f1fa8c/#ff5555` → `text-accent-success/text-accent-warning/text-destructive` (`var(--color-*)` for Recharts fills); ProjectHealthWidget:124 `AlertCircle` → `Ban`.
7. `components/terminal/TerminalSearchOverlay.tsx:94,105-138` — `#f8f8f2/#6272a4/#44475a` → `text-foreground/bg-accent-primary/40/bg-muted`; `:107,115,126` `size={14}` → `className="w-3.5 h-3.5"`.
8. `types/context-scope.ts:51-54` — `text-white` ×4 in `submitAccentForTier` → `text-background` (white on pastel accent-warning is unreadable).
9. `components/FreestyleLaunchDialog.tsx:91` — `bg-emerald-500 text-white hover:bg-emerald-400 focus-visible:ring-emerald-400` → `bg-accent-success text-background hover:bg-accent-success/90 focus-visible:ring-accent-success`; `:58` `h-4.5 w-4.5` → `h-4 w-4` (only off-scale icon in the app).
10. `components/RailControls.tsx:78-85` — raw red/emerald/amber + `aurora-light:` → `text-destructive/text-accent-success/text-accent-warning`; `:42` `hsl(191_97%_77%/0.22)` → `color-mix(in srgb, var(--color-accent-info) 22%, transparent)`; `:88` add `disabled:opacity-40`; bump button `h-5 w-5`→`h-7 w-7`, icon `w-2.5`→`w-3.5`.
11. `components/RailsBoard.tsx:167` — `text-emerald-400 bg-emerald-400/10` → `text-accent-success bg-accent-success/10`.
12. `components/ActiveJobCard.tsx:78,83` — `border-blue-500/30 bg-blue-500/5` / `text-blue-400` → `border-accent-info/30 bg-accent-info/5` / `text-accent-info` (copy JobStatusPanel:189).
13. `components/JobStatusPanel.tsx:191-199` — success/fail frame raw → `border-accent-success/30 bg-accent-success/5 text-accent-success` / destructive set; `:219,317,342` `text-yellow-400` → `text-accent-warning`; `:365` `text-cyan-400/80` → `text-accent-info`; `:423,447,450` `text-muted-foreground/30` → `/50`.
14. `components/PipelineProgress.tsx:34-87` — all phase-state raw palette → `accent-info` (running) / `accent-success` (done) / `destructive` (failed).
15. `components/TicketStatusIndicator.tsx:33-47,138-140` — raw status dots/chips → tokens per §1.1 status map.
16. `components/Navbar.tsx:38-43` — connection pill raw blue/orange/green/red → `accent-info/accent-warning/accent-success/destructive`.
17. `pages/AnalyticsPage.tsx:413-417` — load-failure banner `accent-warning` → `border-destructive/30 bg-destructive/10 text-destructive` (errors are destructive, app-wide).
18. `components/analytics/SpendingTimeline.tsx:82` — smash series `var(--color-accent-highlight)` (duplicates explore) → `var(--color-accent-secondary)`.
19. Scrim normalization — `JobDetailModal.tsx:183` `black/50`→`black/60 backdrop-blur-sm`; `ai-edit/AiEditShell.tsx:179` `black/40`→`black/60`; `TicketDetailModal.tsx:798` + `SplitViewShell.tsx:177` `black/70` (no blur)→`black/60 backdrop-blur-sm`; `OnboardingWizard.tsx:725` + `AttachmentPreviewLightbox.tsx:74` → `black/80 backdrop-blur-md`.
20. `components/ui/dialog.tsx:75,98` — `border-border/30 … shadow-xl` → `border-border/40 … shadow-2xl` (base dialog currently weaker than its own flagship children).
21. `components/ui/select.tsx:17` — SelectTrigger `rounded-lg` → `rounded-md` (matches input/button); `:24` add `transition-transform duration-150 group-data-[state=open]:rotate-180` to chevron.
22. `components/ui/card.tsx:9` — append `transition-colors` (consumers adding `hover:border-*` currently snap).
23. `components/CommandPalette.tsx:141` — `border-border/30` → `border-border/40`; after fix #1, append `animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150 ease-out` + dimmed overlay `bg-black/50 backdrop-blur-sm`.
24. `components/TicketDetailModal.tsx:337-338` — drop `shadow-black/50` (keep `shadow-2xl`); `:623` popover `rounded border-border/50 shadow-lg` → `rounded-lg border-border/60 shadow-xl`.
25. App-frame hairline continuity — `components/StatusBar.tsx:84` `border-t border-border/30` → `border-border`; `components/ChatPanel.tsx:79,114,211,220` structural `/30` → full; `components/agent-chat/AgentModeCodePane.tsx:74` `/60` → full (sibling AgentWorkspaceSidebar:77 already full).
26. `components/settings/TerminalSettingsSection.tsx:196,262` — bare `border` (renders `currentColor`, harsh) → add `border-input`; `:266` `border-t` → `border-t border-border`.
27. Invisible dividers — `components/SpecComparePicker.tsx:96` `divide-border/10` → `/40`; `/20` hairlines at `RailRow.tsx:645`, `JobStatusPanel.tsx:237`, `JobComparisonModal.tsx:43`, `LogViewer.tsx`, `ChatInput.tsx`, `InstallInstructionsModal.tsx`, `TicketGridView.tsx` → `/40`; `RailRow.tsx:690` `/25` → `/40`; `pages/CodePage.tsx:292` `/70` → `/60`.
28. Analytics skeleton/loaded border flash — `components/analytics/{CostScatter:43,ModelBreakdown:20,ProviderBreakdownCard:39,QuickVsExploreCard:93,SpendingHero:59,SpendingTimeline:13,TopTicketsCrossSurface:14}` skeleton `border-border/40` → `/50`.
29. H1 normalization — `pages/JobsPage.tsx:95` `text-sm font-semibold` → `text-lg font-semibold`; `pages/AnalyticsPage.tsx:313` `text-base` → `text-lg`; `pages/DesktopAnalyticsPage.tsx:340` `text-sm` → `text-lg`; `pages/ActivityFeedPage.tsx:78` `text-sm font-medium` → `text-lg font-semibold`.
30. Gutter normalization — `pages/SettingsPage.tsx:248` `max-w-2xl mx-auto px-4` → `max-w-3xl mx-auto px-6`; `pages/JobsPage.tsx:93` `max-w-4xl px-4` → `max-w-6xl px-6`; `pages/JobDetailPage.tsx:395,348,360` `px-4` → `px-6`; `pages/AnalyticsPage.tsx:308-310` `p-4 pb-12`/`-mx-4 px-4` → `px-6 pt-6 pb-12`/`-mx-6 px-6`.
31. `text-[9px]` purge → `text-[10px]`: `SpecCard.tsx:153-224` (or delete override, Badge base is 10px), `TicketPostitCard.tsx:244-286`, `TicketGridView.tsx:185-239`, `TicketListView.tsx:351-383`, `RecentJobs.tsx:368,377`, `DesktopAnalyticsPage.tsx:207`, `RailRow.tsx:600` (+ `tabular-nums`).
32. 10px interactive controls — `TicketListView.tsx:218,234` `text-[10px]` → `text-[11px]`; `:251,266` `h-6 text-[10px]` → `h-7 text-xs`; `RecentJobs.tsx:200,216,283-292` → `text-[11px]`, `:233,240` → `h-7 text-xs`; `GlobalSettingsPage.tsx:554,643` checkbox labels → `text-xs`, `:438-681` descriptions `text-[10px]` → `text-[11px]`.
33. `components/RailRow.tsx:693` — empty state `text-[10px] text-muted-foreground/30` + `border-border/25` → `text-[11px] text-muted-foreground/60` + `border-border/40` (the surface's main onboarding cue fails contrast).
34. Destructive-red sweep — `SpecCard.tsx:235`, `RailRow.tsx:510,613-620`, `agents/PromptDialog.tsx:120` `bg-red-500 text-white hover:bg-red-600` → `bg-destructive text-destructive-foreground hover:bg-destructive/90`; `TicketGridView.tsx:495` `bg-red-950/10` → `bg-destructive/10`; `JobComparisonModal.tsx:90` `text-rose-400` → `text-destructive`.
35. `text-white` sweep → `text-background` (or `-foreground` pair): `ProposeSpecModal.tsx:661`, `App.tsx:466`, `agent-chat/AgentComposer.tsx:267`, `AgentConversationView.tsx:69`, `jira/JiraIntegrationCard.tsx:93`, `ai-edit/AiEditShell.tsx:904`, `ChatPanel.tsx:86`, `LoopsPage.tsx:325`, `LoopBuilderPage.tsx:429`, `IntegrationsPage.tsx:255,632,676`; `FeatureProposalModal.tsx:259,272` `bg-green-600` → `bg-accent-success text-background`, `:314` `CheckCircle` → `CheckCircle2 text-accent-success`.
36. Icon one-liners — `ArcSidebar.tsx:385` BarChart2→PieChart; `DesktopAnalyticsPage.tsx:339` TrendingUp→PieChart; `CommandPalette.tsx:261` FileText→BookOpen; `ActivityFeedPage.tsx:30` Zap→Loader2; `RecentJobs.tsx:183` ClipboardList→Briefcase; `AgentWorkspaceSidebar.tsx:3` TerminalSquare→Terminal + FileCode2→Code2; `GlobalSettingsPage.tsx:13` TerminalSquare→Terminal; `SetupWizard.tsx:451` Bot→Plug; `CodePage.tsx:4` RotateCw→RefreshCw.
37. Markdown/code accent unification → `accent-info`: `ExploreSpecShell.tsx:1236-1240` (accent-primary→info), `SetupChat.tsx:13` + `TicketDetailModal.tsx:1040,1055` + `LogViewer.tsx:446,449` (cyan-300/blue-400→`text-accent-info`), `JobsPage.tsx:127` `prose-code:text-cyan-300` → `prose-code:text-accent-info`; Sparkles tint: `ProposeSpecModal.tsx:405`, `SpecDraftPanel.tsx:39`, `AiEditComposer.tsx:63` `text-primary/70` → `text-accent-primary`.
38. Motion micro — terminal `duration-120` delete (`PanelChevronButton.tsx:32`, `TerminalSidebar.tsx:92,129,145`, `TerminalDragHandle.tsx:86`, `TerminalTopBar.tsx:126`); `ArcSidebar.tsx:401` + `ProjectRightSidebar.tsx:58` `transition-all` → `transition-[width]`; `SpecCard.tsx:124` + `RailRow.tsx:295,527` `animate-jiggle` → `motion-safe:animate-jiggle`; `RailRow.tsx:535` snap-back curve → `cubic-bezier(0.34,1.56,0.64,1)`.
39. Reduced-motion consolidation — wrap the agent-chat portal root in `context/AgentChatContext.tsx` with one `<MotionConfig reducedMotion="user">`, delete the local one at `AgentModeSurface.tsx:41`; add the global `prefers-reduced-motion` clamp to `globals.css`.
40. Glyph → lucide — `AddProjectDialog.tsx:284` `'✓'` → `<Check className="w-2.5 h-2.5"/>`; `ChatHeader.tsx:51` `'+'` → `<Plus className="h-3.5 w-3.5"/>`, `:61-100` four hand-rolled SVGs → `Trash2/Minimize2/Maximize2/X` `h-3.5`; `ModelSelector.tsx:211` `'↺'` → `<RotateCcw className="w-3 h-3"/>`; `×` dismissals (`ProposeSpecModal.tsx:527`, `ChatPanel.tsx:140`, `AttachmentChip.tsx:86`, `AttachmentsSection.tsx:140`, `AnalyticsPage.tsx:332`) → `<X className="w-3 h-3"/>`; `SpecsBoard.tsx:693` done-bucket drag tint `bg-emerald-500/[0.04] aurora-light:*` → `bg-accent-success/[0.06]`; `DashboardPage.tsx:1047` ghost `border-primary/40` → `border-accent-info/40`.

Deferred to a dedicated bulk change (mechanical but broad): the remaining ~40-file `aurora-light:` fork sweep (S1), `pages/AgentsPage.tsx:82-96` yellow banner, `TicketContextMenu`, `AiEditShell` body, `ActivityFeedPage` maps, kicker `font-medium→font-semibold` in 6 analytics files, `ui/card.tsx` recipe migration.

---

# PART 3 — RAILS REDESIGN PROPOSAL

## 3.1 Diagnosis (one sentence)
A single idle rail exposes **13 controls, six of them 10px native `<select>`s explained only by icon+`title`**, the primary action is the smallest target on the card (20px), a running rail is a **black box** (all config unmounts → layout jump; no loop/engine/model/phase shown), failure is **invisible after a 4s toast** (`RailStatus 'failed'` is dead code), and rail identity is three disagreeing coordinate systems (id-number vs array-index vs server-index) sitting on a localStorage/server split-brain.

## 3.2 Target layout (normal density)

```
┌─ rail card ─ rounded-xl border-border/40 bg-card/60 ─────────────────┐
│ ⠿  ●  Backend refactor            2 specs      [▶ Run]  [⋮]         │  header h-9
│ ─────────────────────────────────────────────── border-border/40 ── │
│   #142  Fix auth token refresh                     ▲ high           │  droppable body
│   #147  Add rate limiter                           ■ med            │  (SpecCard rows)
│ ─────────────────────────────────────────────────────────────────── │
│   Implement · Claude · Sonnet · balanced · normal effort        ⌄   │  config summary
└──────────────────────────────────────────────────────────────────── ┘
```

- **Header:** grip (`GripVertical w-3.5 text-muted-foreground/30`) · status dot **`w-2 h-2`** (up from 6px; `bg-accent-success glow-success` running, `bg-destructive` failed, `bg-muted-foreground/25` idle) · free-form name (kill the forced `"Rail "` prefix wrapper at `DashboardPage.tsx:325`; server already models name-or-null) · ticket count `text-[10px] tabular-nums bg-muted/40` · **`[▶ Run]` = `h-7` labeled button** (`text-accent-success`, `w-3.5` icon — no longer a 20px ghost) · **`[⋮]` kebab** (Radix DropdownMenu, menu-tier recipe): Rename / Duplicate / Move all to Specs / Delete (`text-destructive`). Kebab replaces the undiscoverable 800ms long-press-jiggle on desktop; jiggle+swipe stay for touch.
- **Config summary strip (the key consolidation):** the six micro-selects collapse into **one readable sentence of chips** — `<Loop> · <Engine> · <Model> · <Profile> · <Effort>` at `text-[11px]`, each chip a real `ui/tooltip.tsx`-labeled target. Clicking any chip (or `⌄`) opens **one config popover** (menu-tier recipe, `rounded-lg border-border/60 bg-popover/95 backdrop-blur-md shadow-xl`, grid-rows disclosure at 250ms) containing proper **labeled Radix `ui/select`s** — Loop, Engine, Model, Profile, Reasoning effort — plus the **Interactive switch** (moved here from the transport row; it is config, not transport). Visible controls per idle rail: **13 → 5** (grip, name, Run, kebab, config strip). All selector visibility rules (multi-provider, claude-only profile, mode-derived model/effort) survive unchanged inside the popover.
- **Empty body:** `text-[11px] text-muted-foreground/60` on `border-border/40` dashed — "Drag specs here" finally visible.

## 3.3 States and motion

| State | Card | Config strip | Right slot | Motion |
|---|---|---|---|---|
| **idle** | `border-border/40` | chips, editable | `▶ Run` (disabled `opacity-40` at 0 tickets) | drop-hover: body `bg-accent-info/[0.06]` + card `border-accent-info/50 glow-info` — ONE accent for one interaction (kill the `primary` variant at RailRow:530) |
| **running** | `border-accent-info/40` + **`glow-info`** (works once fix #4 lands) | **stays mounted**, `opacity-60 pointer-events-none` — no layout jump; chips show the resolved run (`loopName · provider · model` already returned by `rails-router.ts:86-105`, today thrown away) | `■ Stop` (`text-destructive`) + `Log` | below strip: live line `Loader2 w-3 animate-spin text-accent-info` + `elapsed · steps · lines` `text-[11px] tabular-nums`, plus **mini `PipelineProgress`** (compact variant of the existing component, fed by the same WS stream `RailMetricsContext` already consumes) with `AgentActivityChip`-style AnimatePresence crossfade on phase change |
| **done** | 800ms `border-accent-success/50 glow-success` wash, then back to idle | re-enabled | `▶ Run` | persistent last-run line replaces the live line: `CheckCircle2 w-3 text-accent-success` `Shipped 3 specs · 12m · $0.84` until next config touch; completion toast uses the rail **label**, not "Rail {{n}}" |
| **failed** | **persistent** `border-destructive/40` + dot `bg-destructive` (resurrect the dead `'failed'` status: `applyRailJobOutcome` at `RailsBoard.tsx:56-72` must set it — the `RailControls.tsx:81-98` retry affordance already exists, unreachable today) | re-enabled | `AlertTriangle` Retry + `Log` + dismiss-`X` | card does one `motion-safe` shake-in (4px, 300ms); state survives until retry/dismiss |

**Stop guard:** Stop cancels N billed jobs — replace bare kill with a 5s undo toast (`ThemedToaster` action pattern, `App.tsx:434`) or a one-line confirm; no new component needed.

## 3.4 Reused components (nothing new except one popover)
`ui/select.tsx` + `ui/tooltip.tsx` + `ui/dropdown` primitives (Radix, already shipped) · `PipelineProgress` (add a `variant="mini"` — h-1.5 bar + phase label) · `Badge` (post fix #3, for ticket/status chips) · `AgentActivityChip` crossfade pattern (copy verbatim for phase/status text) · `glow-*` utilities (`globals.css:345-350`) · `TicketDetailModalProvider` (compact ticket-pill clicks, unchanged) · `MoveToRailPopover`, `FreestyleLaunchDialog` (kept as-is, minus emerald CTA per fix #9) · existing WS events + `GET /rails` enrichment (`activeLoopRuns.loopName/provider/model/iteration` — zero server work to show run identity) · shared `<EmptyState>` (new, but mandated app-wide by §1.5). Compact density is **retired as a separate design system**: it becomes the same card with the body collapsed — the compact branch is already the token-correct one, so normal density adopts its token language rather than maintaining two.

## 3.5 Phased plan

**Phase 0 — identity + persistence prerequisite (structural bug fix, blocks everything).** Collapse the three coordinate systems: put the **server railIndex** on `RailState` as the single key; rename (`DashboardPage.tsx:329` `parseInt(railId)-1`), profile/engine/launch/stop (`:764,:820,:835` `findIndex`), and WS mirrors (`:362,:375,:404`) all route through it. Today, reordering/deleting a rail mis-routes PUTs and lights up the wrong card. Fix N+1 fetches by hoisting profile/loop fetches to `RailsBoard` (one fetch, pass down). Delete dead plumbing (`RailControls.tsx:31` `loopAvailable`/`onModeChange`, `DashboardPage.tsx:758-760`).

**Phase 1 — cosmetic reskin (pure class/markup, ships independently).** All rails-touching mechanical fixes (#4, #9, #10, #11, #31, #33, #34, #38): working glow-info running border, token status dot at `w-2 h-2`, `h-7` labeled Run/Stop, 11px floor on selects/pills/empty state (`h-6 text-[11px]` interim on the native selects), one drop accent (accent-info), destructive-token delete affordances, icon on the loop-model select, toast copy uses rail label + translated loop name (`DashboardPage.tsx:938,407-412`). **Config strip stays mounted while running** (disabled, not unmounted) — kills the layout jump with zero structural change. Add the run-identity chips from the already-delivered `activeLoopRuns` payload.

**Phase 2 — structural.** (a) **Rails fully server-side**: server already persists tickets/mode/profile/engine/name and broadcasts `rail.updated`; localStorage demotes to cache; lift the hardwired `[0,1,2]` (`rails-store.ts:59`) so rails 4+ exist for the mobile companion too. (b) **Config popover** replacing the six inline selects (the 13→5 consolidation above), Interactive as a switch inside it. (c) **Failed state wiring** end-to-end (`applyRailJobOutcome` → `'failed'`, retry/dismiss UI). (d) **Mini PipelineProgress + last-run summary line.** (e) **Kebab menu + Stop undo-toast + free-form names** (drop the `"Rail "` prefix contract, default label only when name is null). (f) Motion polish: spring arrival for added rails, FLIP (`motion` `layoutId`) for spec cards moving board⇄rail — same `LayoutGroup` work as the SpecsBoard cross-column fix, shared spring `{stiffness:350,damping:34}`.

Acceptance for "premium": no text below 11px on the surface, one accent per interaction, running rail answers "what is running, with what, how far along" without leaving the dashboard, failure is visible until acknowledged, and every glow actually renders.
