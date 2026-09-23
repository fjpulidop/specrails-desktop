## Context

`DashboardPage.tsx` actualmente renderiza dos `flex-1` con un `border-r` estático: izquierda `SpecsBoard`, derecha `RailsBoard`. No hay forma de cambiar la proporción. Las cards de spec son filas finas (densidad alta) optimizadas para escanear muchas a la vez, pero pobres para entender contexto sin abrir el modal.

Por otro lado, varios flujos AI ya escriben title + description con un coste no trivial. Añadir un campo `short_summary` aprovechando esas mismas llamadas tiene coste marginal cero.

El sistema de morfismo debe sentirse premium y orgánico, no solo funcional — esto es una de las vistas más usadas del hub.

## Goals / Non-Goals

**Goals:**

- Splitter vertical arrastrable persistido por proyecto.
- 3 tiers visuales (row → card → postit) con snap a breakpoints; transiciones suaves.
- `short_summary` persistido, generado solo cuando un flujo AI escribe/actualiza la spec.
- Panel de rails colapsado premium: nombre + Mode + Profile + Play/Stop/Log en ≤180px de ancho.
- Cero cambios al protocolo WS, endpoints REST (solo enriquecimiento), o `specrails-core`.

**Non-Goals:**

- Backfill de `short_summary` para tickets antiguos.
- Regeneración manual de summary desde un botón (write-once por flujo AI).
- Splitter horizontal adicional (el existente Spec/Done sigue intacto).
- Cambios en drag-and-drop ticket→rail existente (Move-to-Rail es un atajo, no reemplazo).
- Nuevos endpoints REST para gestión de summary.

## Decisions

### Splitter vs reemplazar layout

**Decisión**: Splitter draggable con `pointermove` + `requestAnimationFrame` throttling, manteniendo los dos paneles existentes. No usar librería externa (`react-resizable-panels`) — añade dependencia para algo simple.

**Alternativa descartada**: CSS `resize: horizontal` en el panel izquierdo. Rechazado porque no permite snap zones ni feedback visual durante el drag.

**Persistencia**: `localStorage['specrails-hub:dashboard-split:<projectId>']` guarda ancho en px del panel izquierdo. Restaurar en mount; clamp al viewport al rehidratar (si el usuario cambió de resolución).

### Tiers de morfismo

**Decisión**: 3 tiers discretos con snap:

| Tier | Trigger | Layout |
|------|---------|--------|
| `row` | ancho ≤ 600px | TicketListView actual sin cambios |
| `card` | 600 < ancho ≤ 900px | grid 2-3 columnas, card mediana (título + priority + dep) |
| `postit` | ancho > 900px | grid auto-fill ~260px, postit cuadrado con summary y botón Move to Rail |

`ResizeObserver` en el contenedor izquierdo dispara cambios de tier. Snap zones en 600 y 900 px: si el usuario suelta dentro de ±30px del breakpoint, anima al breakpoint exacto.

Framer-Motion `layout` + `layoutId` por ticket: cuando un ticket cambia de tier, su posición/forma anima suavemente sin reflow brusco.

**Alternativa descartada**: morfismo continuo (interpolación lineal del ancho/alto de cada card). Rechazado por:
1. Reflow constante durante el drag, mata performance con muchas specs.
2. Tipografía y truncado intermedio se ve raro.
3. Tiers discretos se sienten más "intencional", menos "estiramiento goma".

### `short_summary` — schema y generación

**Decisión schema**: nueva columna `short_summary TEXT NULL` en `tickets`. Migración nueva en `server/modules/specs/runtime/ticket-store.ts` (siguiendo el patrón existente con `schema_version` bump). El JSON store mirror también se extiende.

**Decisión generación**: extender los prompts AI ya existentes para que devuelvan un campo extra `shortSummary` en su JSON de salida. El parser tolera campo ausente (legacy responses) — no rompe nada.

Flujos a tocar:

1. **Quick** (`server/project-router.ts` `POST /tickets/generate-spec`): prompt actual + "Also produce a `shortSummary` field (max 120 chars, 2 lines, plain language)".
2. **Explore from-draft** (`POST /tickets/from-draft`): ya invoca al modelo para enriquecer; añadir el campo.
3. **SMASH** (`specs-smash` engine, ambos modos Simple y Full): cada sub-spec creada recibe su propio `shortSummary` generado en la misma llamada de decomposición.
4. **AI Refine** (`server/modules/agents/runtime/agent-refine-manager.ts`): si la refine produce un nuevo título o descripción, regenera `shortSummary`. Si no, se conserva el anterior.
5. **Contract Refine** (`server/modules/specs/runtime/contract-refine-runner.ts`): no toca summary (su scope es Contract Layer únicamente).

**Validación**: trim, max 240 chars de seguridad (HARD cap server-side), null si vacío. No HTML, solo texto plano.

**Alternativa descartada**: campo separado generado por una llamada AI dedicada. Rechazado por coste y latencia — añadir un campo al JSON de salida cuesta ~20-50 tokens vs llamada nueva ~500+ tokens.

### Move to Rail popover

**Decisión**: popover Radix con lista de rails del proyecto. Click en rail → emite el mismo evento de assignment que el drop actual (reusar `handleTicketToRailDrop` o equivalente extraído como helper). Cero cambios server.

### Rails panel colapsado premium

**Decisión**: `RailRow` actual (299 líneas) se refactoriza para aceptar prop `density: 'normal' | 'compact'`. En `compact` (cuando el panel < 220px):

```
┌──────────────┐
│ ◉ Rail Alpha │  ← truncate-1, label + status dot
│ Impl ▾  P ▾ │  ← Mode + ProfilePicker en línea
│  ▶   ⏹   📋 │  ← Play/Stop/Log iconos
│   2 specs    │  ← counter
└──────────────┘
```

Glass card: `bg-card/80 backdrop-blur border border-border/40 rounded-xl shadow-sm`. Hover: `hover:border-accent-info/40 hover:shadow-md transition`. Estado running: borde `accent-success/40` + pulso suave.

ProfilePicker existente ya tiene variante compacta utilizable; si no, añadir prop `compact`.

### Persistencia y snap UX

- `localStorage` key per-project: `specrails-hub:dashboard-split:<projectId>` (sigue patrón terminal panel).
- Doble-click en el splitter → reset a 50/50.
- Snap visual: marcador sutil (línea de 1px translúcida) en los breakpoints 600/900 px del panel izquierdo cuando el mouse está dentro de la zona de snap.

## Risks / Trade-offs

- **[Reflow durante drag]** → throttle `pointermove` con `requestAnimationFrame`; cards usan `layout` de Framer-Motion (transform-based, no relayout).
- **[Migración SQL existente en producción]** → migración additive (`ALTER TABLE tickets ADD COLUMN short_summary TEXT NULL`); SQLite la aplica sin lock significativo en tablas pequeñas; idempotente vía check de schema_version.
- **[Modelo no devuelve `shortSummary`]** → parser tolera ausencia, persiste null; UI no rompe (oculta zona summary del postit).
- **[Splitter persistido > viewport en pantalla pequeña]** → clamp en mount al rango `[minLeft, viewport - minRight]` (e.g. 320 ↔ vw-180).
- **[AI Refine podría borrar summary previo sin querer]** → solo regenerar si el refine devuelve `shortSummary` explícito; en caso de ausencia, mantener el anterior.
- **[Móvil / pantallas muy angostas]** → debajo de cierto viewport (e.g. < 900px total), splitter se deshabilita y panel izquierdo ocupa 100%; comportamiento dashboard actual sin cambios.
- **[Coverage 80% server, 80% client]** → cobertura para migración, parser de cada flujo AI (4-5 callsites), render de los tiers, snap behavior, restauración localStorage.

## Migration Plan

1. Migración SQL `short_summary` (idempotente, sin breaking).
2. Server: extender los 4 flujos AI uno por uno con tests; el orden no importa porque el campo es opcional.
3. Client: introducir splitter detrás de un feature flag `VITE_FEATURE_DASHBOARD_MORPH` (default `false` durante desarrollo, `true` al merge).
4. Refactor componentes en orden: `SpecsBoard` (tiers) → `TicketPostitCard` (nuevo) → `MoveToRailPopover` → `RailRow` (compact mode) → wire en `DashboardPage`.
5. Rollback: el feature flag permite revertir UI sin tocar datos; el campo `short_summary` queda en DB pero ignorado.

## Open Questions

- ¿Doble-click del splitter resetea a 50/50 o al último snap? — propuesta: 50/50, más predecible.
- ¿Hay un edit-spec manual del lado UI hoy (textarea sin AI)? Si sí, no dispara regeneración (consistente con la regla "solo flujos AI").
