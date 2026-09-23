## Why

Hoy el dashboard parte la pantalla 50/50 fija entre `SpecsBoard` (izquierda) y `RailsBoard` (derecha). El usuario no puede priorizar visualmente las specs sobre los rails (ni viceversa) cuando su tarea lo requiere. Además, las cards de ticket actuales son filas compactas sin contexto visual rápido — para entender de qué va una spec hay que abrir el modal de detalle.

## What Changes

- Añadir splitter vertical arrastrable entre los dos paneles del dashboard, persistido por proyecto en `localStorage`.
- Conforme el panel izquierdo crece, las cards del `SpecsBoard` morfan en 3 tiers discretos con snap: **row** (ancho actual) → **card** (intermedio) → **postit** cuadrado (modo expandido).
- En modo **postit**, cada ticket muestra: `#id`, título, priority pill, indicador de dependencia, `short_summary` (si existe) y botón **"Move to Rail"** (popover con rails disponibles, atajo al drop existente).
- Añadir campo nuevo `short_summary TEXT NULL` en tabla `tickets` (migración SQL en `server/modules/specs/runtime/ticket-store.ts`).
- Generar `short_summary` (~120 chars, 2 líneas) **solo en escritura/actualización AI de la spec**, dentro de la misma llamada existente (coste extra ~0):
  - Quick: `POST /tickets/generate-spec`
  - Explore: `POST /tickets/from-draft`
  - SMASH (Simple + Full): sub-spec decomposition
  - AI Refine: `agent-refine-manager.ts`
  - Contract Refine: `contract-refine-runner.ts` (mantener el existente intacto, solo extraer summary si el modelo lo devuelve)
- Tickets antiguos sin summary → no se renderiza esa zona del postit. No hay backfill, no hay botón "regenerate manual".
- Cuando el panel derecho colapsa al mínimo (~180px), las rail cards adoptan un layout vertical premium compacto: nombre, dropdown Mode (Implement/Batch), `ProfilePicker` (si el proyecto soporta perfiles), botones Play/Stop/Log, contador de specs asignadas.
- Snap zones del splitter ancladas a los breakpoints de morfismo + transiciones suaves vía Framer-Motion `layout` para sensación orgánica.

## Capabilities

### New Capabilities

- `dashboard-split-layout`: splitter vertical arrastrable persistido por proyecto entre `SpecsBoard` y `RailsBoard`, con snap zones que disparan tiers de visualización de cards (row/card/postit) y un layout premium compacto del panel de rails cuando se colapsa.
- `ticket-short-summary`: campo `short_summary` persistido en la tabla `tickets`, generado por la misma llamada AI que crea o actualiza la spec; mostrado en la vista postit del dashboard.

### Modified Capabilities

- `specs-smash`: la decomposición SMASH (Simple y Full) debe rellenar `short_summary` en cada sub-spec creada.
- `explore-spec`: el flujo `from-draft` debe extraer y persistir `short_summary` desde la llamada que genera la spec final.
- `ai-refine-custom-agents`: AI Refine debe regenerar `short_summary` cuando el resultado actualice título o descripción.

## Impact

- **Server**: nueva migración SQLite añadiendo `tickets.short_summary TEXT NULL`. Extensión de prompts y parsing JSON en los flujos AI listados (Quick generate, Explore from-draft, SMASH, AI Refine). El campo es opcional en la respuesta del modelo — si no viene, se persiste null sin romper el flujo.
- **Client**: refactor de `DashboardPage.tsx` para introducir splitter; refactor de `SpecsBoard.tsx` para renderizar los tres tiers según ancho contenedor (con `ResizeObserver`); nuevo componente `TicketPostitCard` y `MoveToRailPopover`; refactor de `RailsBoard.tsx`/`RailRow.tsx` para soportar el layout colapsado premium.
- **Tipos compartidos**: extender `Ticket` interface con `short_summary?: string | null`.
- **Tests**: cobertura para migración, render de tiers, persistencia del splitter, generación de summary en cada flujo AI, regresiones del drop-to-rail existente.
- **No afecta**: protocolo WebSocket, endpoints REST existentes (solo se enriquecen las respuestas con el nuevo campo), `specrails-core`, persistencia de tickets antiguos.
