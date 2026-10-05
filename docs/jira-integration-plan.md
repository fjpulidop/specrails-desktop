# Jira como fuente de Specs — Estudio e implementación

> **Estado: v1 IMPLEMENTADO en specrails-desktop** (Fase 0 + Fase 1). Subsistema `server/jira/` + UI wizard + tests; core y companion sin cambios. Ver la sección "Jira integration" en `CLAUDE.md` para el mapa de código. Las Fases 2–3 (OAuth 3LO, keychain OS, conflictos bidireccionales, sink de comentarios Jira→local, relay de webhooks) siguen pendientes. Producto: Specrails (core + desktop + companion).
> Objetivo: que una Spec **pueda ser** un ticket de Jira, con **hot‑swap** por proyecto entre tickets locales y tickets de Jira, siguiendo todo el ciclo de vida (crear → To Do → In Progress → Done / revertir), y dejando un comentario en Jira al terminar el job del rail.
> Conclusión de cabecera: **specrails‑core no necesita ningún cambio**; el 95 % del trabajo vive en specrails‑desktop; specrails‑companion necesita ~0 (campos aditivos opcionales).

---

## 1. Veredicto ejecutivo

La feature es viable, de alto valor enterprise, y — crucialmente — se puede construir **sin tocar el contrato congelado de core ni el de la app móvil**. La arquitectura ganadora (validada por un panel de 3 arquitectos + 3 jueces y un barrido adversarial de 87 corner cases) es:

> **Desktop es la capa de sincronización. El store local `local-tickets.json` sigue siendo la caché de lectura canónica. Jira es el sistema de registro. El hot‑swap es un *cambio de destino de escritura*, no un refactor del camino de lectura. Toda la escritura a Jira pasa por un *outbox transaccional durable* en SQLite.**

Tres decisiones la sostienen:

1. **Core intacto.** Desktop materializa Jira → `.specrails/local-tickets.json` (lo que core ya lee) y escribe `.specrails/backlog-config.json` con `provider:"local"` + `write_access:false`. Eso mete a core en su rama **read‑only**: lee tickets de la caché pero **nunca** muta estado ni habla con Jira. Desktop (`applyJobOutcomeToTickets`) queda como **única autoridad de estado**.
2. **No refactorizar el store en v1.** No introducimos todavía una interfaz `TicketProvider` que obligue a reescribir los ~27 importadores de `ticket-store.ts` (el módulo más sensible: advisory‑lock, atomic‑rename, supresión de eco del watcher, regla de no‑resurrección de draft/cancelled). Eso se difiere hasta que exista un **segundo** backend (GitHub Issues/Linear) que justifique la abstracción. En v1, un `JiraSyncManager` *al lado* de los managers existentes en `ProjectContext`.
3. **Durabilidad desde el día 1.** Escritura caché + fila de outbox en **una sola transacción SQLite** → es imposible perder una transición o un comentario por crash/offline. Idempotencia en cada operación. Esto es lo verdaderamente "load‑bearing" de cualquier write‑back a Jira y es barato incluirlo desde el principio.

Lo que **se descarta para v1** (con motivo): webhooks entrantes (el server liga a `127.0.0.1`, sin ingress público); OAuth 2.0 3LO (el token endpoint de Atlassian exige `client_secret`, sin device‑flow → necesitaría un *token‑broker* hospedado que no existe); resolución de conflictos campo‑a‑campo bidireccional; interfaz `TicketProvider` genérica; sink de comentarios Jira→local.

---

## 2. Respuesta directa a tus preguntas

### ¿Cómo impacta a cada repo?

| Repo | Impacto | Detalle |
|------|---------|---------|
| **specrails-core** | **Cero cambios** | Core nunca lee tickets por código: cada lectura/escritura es un agente LLM siguiendo instrucciones markdown contra `.specrails/local-tickets.json`, gateado por `.specrails/backlog-config.json` (`{provider, write_access, git_auto}`). La ruta del fichero está *hardcodeada* en cada skill, así que redirigir la **ubicación** sí requeriría tocar core — pero redirigir el **contenido** (materializar Jira en esa ruta fija) no requiere nada. Con `write_access:false` core entra en su rama read‑only (`implement.md:1307`: "Do NOT create, modify, or comment on any issues/tickets") e imprime una tabla de actualización manual en vez de mutar. |
| **specrails-desktop** | **~95 % del trabajo** | Nuevo subsistema `server/jira/`: cliente HTTP, materializador (poll → `local-tickets.json`), outbox durable, resolver de estados/transiciones, store de credenciales cifrado, router REST + eventos WS, y UI cliente (toggle de fuente, badge Jira, panel de sync/dead‑letter, settings de conexión). Dos *hooks* en código existente (lanzamiento de rail + salida de job). |
| **specrails-companion** | **~0 (aditivo opcional)** | Los deserializadores Dart son **tolerantes** (`models.dart:1-4`: "parsers are deliberately tolerant … so a schema tweak never crashes the app"). Añadir `jiraKey`/`source`/`externalStatus`/`externalUrl` al JSON REST de `/tickets` es ignorado sin crash. Opción A: cero cambios y la spec Jira ya se ve. Opción B (recomendada): 2 ediciones aditivas para un badge "PROJ‑123" de primera clase. Ningún string del contrato congelado (`hub.*`, `specrailshub` mDNS, campos de pairing) se toca. |

### El ciclo de vida que describiste, mapeado

Tu descripción actual:
- En el listado de Specs = **To Do**; al pasar al rail = **In Progress**; al terminar = **Done**; cancelación/fallo = vuelve a **To Do**.

Cómo se implementa hoy en desktop (verificado):
- `todo → in_progress`: **no se escribe en servidor**. Lo escribe el agente CLI de core en `local-tickets.json`, o lo infiere el tablero por pertenencia al rail. (`rails-router.ts:293-298` solo hace `enqueue` + `railJobs.set` + broadcast `rail.job_started`; `QueueManager` nunca escribe estado de ticket.)
- `in_progress → done` / `→ todo` / `needs_review`: un único sitio, `applyJobOutcomeToTickets` (`ticket-store.ts:324-353`), invocado solo desde `onJobFinished` en `project-registry.ts:315-317` (envuelto en `mutateStore`).

Con Jira, cada transición local se refleja en Jira vía outbox, en **dos chokepoints exactos**:

| Transición Specrails | Dónde se emite | Acción Jira (encolada en outbox) |
|----------------------|----------------|----------------------------------|
| `todo → in_progress` (lanzar rail) | `rails-router.ts:293-298`, justo tras `enqueue` (con `rail.ticketIds` en scope) | Transición a categoría `indeterminate` + escribir `in_progress` en la caché local (porque `write_access:false` quita la escritura de core) |
| `in_progress/todo → done` (job OK) | `project-registry.ts:315-327`, tras el broadcast loop | Transición a categoría `done` + **comentario de finalización** |
| `in_progress → todo` (fallo/cancel/zombie) | mismo sitio | Transición *best‑effort* hacia categoría `new` (puede no existir camino — ver §6) + comentario |
| `done + needs_review` (murió tras Ship) | mismo sitio | **NO** transicionar a Done; en su lugar comentario ("run terminó anormalmente, revisar") + label `specrails:needs-review` |

> Punto crítico verificado: el `in_progress` de lanzamiento **NUNCA** lo emite la app server‑side, y con `write_access:false` el agente CLI **tampoco** lo escribirá. Por eso el push de `In Progress` a Jira **debe** emitirse explícitamente desde el hook de lanzamiento — no se puede depender del file‑watcher ni del agente.

### Crear el ticket y comentar al final

- **Crear**: el flujo Add Spec gana un destino. Si la fuente del proyecto es Jira (o el usuario elige "crear en Jira"), `POST /rest/api/3/issue` crea el issue (project + issuetype + summary + descripción en ADF), se mintea un `#id` local estable y se inserta la fila en `jira_links`. Si es local, ruta actual sin cambios.
- **Comentar al terminar**: el comentario de finalización ("Implementado por Specrails — job N, coste $X, duración Z, PR #…") se compone en el chokepoint de `onJobFinished` (que ya tiene `status`, `costUsd`, `jobRow.duration_ms`, `completedTicketIds` en scope) y se encola como op de outbox **independiente** de la transición (para que si la transición falla por workflow, el comentario igualmente se publique).

---

## 3. Arquitectura

```
                    ┌────────────────────────── specrails-desktop ──────────────────────────┐
                    │                                                                          │
  Jira Cloud/DC ◀──▶│  server/jira/                                                            │
  REST v3 / v2      │   ├─ jira-client.ts        (HTTP: Basic Cloud / Bearer DC, ADF vs wiki)  │
  (poll + outbox)   │   ├─ jira-sync-manager.ts  (per-project; poll loop + outbox drainer)     │
                    │   ├─ jira-outbox.ts        (durable SQLite outbox + dead-letter)         │
                    │   ├─ jira-status-resolver.ts (two-tier map + BFS transition walk)        │
                    │   ├─ jira-materializer.ts  (Jira issues → local-tickets.json, surgical)  │
                    │   ├─ jira-links.ts         (immutable-id ↔ local #id map)                 │
                    │   └─ jira-credential-store.ts (libsodium secretbox behind interface)     │
                    │                                                                          │
                    │  Hooks (2):  rails-router.ts:293  +  project-registry.ts:315             │
                    │  Lee/escribe: .specrails/local-tickets.json  (vía mutateStore, locked)   │
                    │  Escribe:    .specrails/backlog-config.json {provider:local, write:false} │
                    └──────────────────────────────────────────────────────────────────────────┘
                                   │ lee local-tickets.json (sin saber que viene de Jira)
                                   ▼
                            specrails-core  (agente LLM, rama read-only, CERO cambios)
```

**Principio rector — "al lado, no a través" (beside, not through):** el `JiraSyncManager` se monta en `ProjectContext` junto a `chatManager`, `ticketWatcher`, etc. (sitio de construcción en `project-registry.ts:380`). Los ~27 importadores de `ticket-store.ts` quedan intactos. La mutación local en `onJobFinished` sigue siendo **síncrona** (como hoy); solo el efecto secundario hacia Jira se hace **asíncrono y durable**. Esto evita el movimiento más peligroso (async‑ificar `applyJobOutcomeToTickets` en el chokepoint de salida de job, que gobierna la liberación de tickets del rail).

---

## 4. Modelo de datos

### 4.1 Config por proyecto (registro de proyectos, desktop-db)

Nueva columna `ticket_source TEXT DEFAULT 'local'` (`'local' | 'jira'`) en la tabla de proyectos (migración aditiva, mismo patrón que `provider`/`providers` migr. 10/11). Más una fila de conexión Jira (ver 4.4). **Invariante** (espejo del multi‑provider): cuando `ticket_source='local'` todo se comporta byte‑idéntico a hoy; ningún selector se renderiza, ninguna credencial se persiste.

### 4.2 `.specrails/backlog-config.json` (lo escribe desktop, lo lee core)

```json
{ "provider": "local", "write_access": false, "git_auto": false }
```

`provider:"local"` (no `"jira"`) es **deliberado**: mantiene a core fuera del camino `curl`‑a‑Jira; desktop es lo único que autentica contra Jira. `write_access:false` mete a core en read‑only.

### 4.3 `jira_links` (per-project `jobs.sqlite`, nueva migración)

La tabla más importante del diseño. **Clave: el id numérico INMUTABLE de Jira**, jamás la key mutable `PROJ-123`.

```sql
CREATE TABLE jira_links (
  local_id         INTEGER PRIMARY KEY,   -- el #id que ve core; monotónico, NUNCA reusado
  jira_issue_id    TEXT NOT NULL UNIQUE,  -- id numérico inmutable de Jira (sobrevive move/rename)
  jira_key         TEXT,                  -- 'PROJ-123' — solo display, re-resuelto por id si 404
  jira_project_id  TEXT NOT NULL,
  deployment       TEXT NOT NULL,         -- 'cloud' | 'dc'
  last_remote_hash TEXT,                  -- detección barata de divergencia inbound
  status_category  TEXT,                  -- última categoría conocida (new|indeterminate|done)
  state            TEXT DEFAULT 'linked', -- linked | orphaned | conflict
  created_at       TEXT, updated_at TEXT
);
```

Razones (de los corner cases data‑model): un issue **movido** de proyecto cambia la key pero no el id; un **rename de project key** reescribe todas las keys. Si la clave de join fuera la key, cada transición/comentario daría 404 y el poll filtrado por `project=` lo perdería. Los `local_id` se asignan una vez y se **tombstonean** al borrar (nunca se renumeran), para que un `/specrails:implement #42` capturado al lanzar siga resolviendo al mismo issue tras re‑materializaciones y reinicios.

### 4.4 `jira_connection` (per-project) + credencial cifrada

```sql
CREATE TABLE jira_connection (
  project_id   TEXT PRIMARY KEY,
  base_url     TEXT NOT NULL,        -- https://acme.atlassian.net  |  https://jira.acme.com
  deployment   TEXT NOT NULL,        -- 'cloud' | 'dc' (detectado al bind)
  api_version  TEXT NOT NULL,        -- '3' | '2'
  auth_scheme  TEXT NOT NULL,        -- 'basic' | 'bearer'
  account_email TEXT,                -- solo Cloud (Basic = base64(email:token))
  jira_project_key TEXT NOT NULL,
  jira_project_id  TEXT NOT NULL,    -- inmutable; la key puede renombrarse
  status_map   TEXT,                 -- JSON: override explícito spec-status → Jira status id
  high_water_ms INTEGER,             -- marca de poll (epoch ms; resolución real = minuto)
  created_at TEXT, updated_at TEXT
);
```

El **token** NO va en esta tabla en claro. Va en `jira-credential-store.ts` (ver §5): `crypto_secretbox` de libsodium sellado bajo un keyfile `0600`. En lectura se devuelve solo `hasToken: boolean` (espejo de la redacción de `publicWebhook`); el token jamás se devuelve al cliente ni al companion, nunca se loguea.

### 4.5 `jira_outbox` (per-project `jobs.sqlite`) — el corazón de la durabilidad

```sql
CREATE TABLE jira_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  jira_issue_id   TEXT NOT NULL,      -- FIFO se serializa por este id
  op_type         TEXT NOT NULL,      -- 'transition' | 'comment' | 'create'
  idempotency_key TEXT NOT NULL UNIQUE, -- (job_id + ticket_id + op_type)
  payload         TEXT NOT NULL,      -- JSON: target category / comment body / etc.
  issue_version   TEXT,               -- versión/ETag capturada al encolar (freshness check)
  state           TEXT DEFAULT 'pending', -- pending | inflight | done | dead
  attempts        INTEGER DEFAULT 0,
  next_attempt_at TEXT, last_error TEXT, dead_reason TEXT,
  created_at TEXT, updated_at TEXT
);
```

**El invariante transaccional:** la fila de outbox se inserta en la **misma transacción SQLite** que registra el cambio de estado, *antes* de aplicar la mutación a `local-tickets.json` (que es JSON en disco, no SQLite). El outbox es la fuente de verdad durable de "qué debe llegar a Jira". Si el proceso muere entre escribir `done` en el JSON y encolar, no se pierde nada porque el outbox se persistió primero; al arrancar se drenan las filas no‑acked.

---

## 5. Autenticación

### v1 — token‑paste (recomendado), cero backend

| | Cloud | Data Center / Server |
|---|---|---|
| Método | API token + email (**Basic**) | Personal Access Token (**Bearer**) |
| Header | `Authorization: Basic base64(email:token)` | `Authorization: Bearer <PAT>` |
| Base path | `/rest/api/3` | `/rest/api/2` |
| Body comentario/desc | **ADF** (JSON) | **wiki‑markup** (string plano) |
| Versión mínima | — | Jira 8.14+ (si no, basic auth) |

Por qué token‑paste y no OAuth en v1:
- OAuth 3LO de Atlassian **exige `client_secret`** (sin PKCE para public client, sin device flow), que no se puede embeber con seguridad en un binario distribuido → forzaría un **token‑broker hospedado** que veríamos y que dispara revisiones de seguridad enterprise ("¿vuestro servidor ve nuestros tokens?"). Token‑paste mantiene la credencial **en la máquina**.
- DC **no tiene** OAuth 3LO Cloud; el PAT es el único camino limpio. Token‑paste cubre ambos despliegues con un solo UX.
- Loopback redirect (`http://localhost`) sí está whitelisteado por Atlassian, así que **OAuth es el v2 correcto** para orgs que deshabilitan API tokens — pero detrás de la misma interfaz de credencial.

**Realidades operativas a manejar (de la investigación):**
- Tras 15‑dic‑2024 todo API token Cloud **expira** (máx 1 año, sin refresh). Tokens legacy se están **forzando a expirar** entre mar‑2025 y may‑2026. ⇒ UX consciente de expiración: detectar 401, pausar el outbox del proyecto, banner "token Jira expirado — re‑pega en Settings", reanudar drenaje tras re‑auth (la idempotencia hace el replay seguro).
- Muchas enterprises **deshabilitan** la creación de API tokens org‑wide o imponen expiraciones cortas → documentarlo y tener OAuth como ruta v2.

### Cifrado en reposo

`jira-credential-store.ts` expone una interfaz de un solo fichero. **v1**: libsodium `crypto_secretbox` bajo keyfile `0600` (estrictamente más fuerte que el listón actual de plaintext del webhook‑HMAC, **sin plugin nativo**). **v2**: swap a Tauri keychain/stronghold = cambio de un fichero (no toca `src-tauri`/Cargo/firma/notarización en v1). En Windows, donde los permisos POSIX de `secure-fs.ts` son no‑op, documentar que una cuenta‑OS compartida no es frontera de seguridad soportada en v1.

---

## 6. Ciclo de vida y mapeo de estados (la parte difícil)

Los issues de Jira **no tienen un campo `status` asignable** — hay que **transicionar**, y las transiciones están **gateadas por el workflow** del cliente (que es arbitrario). Las 5 lógicas de Specrails (`todo/in_progress/on_review/done/cancelled`) deben caer sobre N estados de cliente repartidos en solo **3 categorías estables**: `new` / `indeterminate` / `done` (`statusCategory.key`).

### Resolver de dos niveles

1. **Mapa explícito por proyecto gana siempre.** En Settings el usuario elige, de la **lista real de estados** de su proyecto (fetched en vivo), el target para cada estado lógico. Esto resuelve la ambigüedad (p.ej. dos estados sobre categoría `done`: `Released` vs `Won't Do`).
2. **Fallback por categoría** cuando no hay mapa: anclar en `statusCategory.key` (nunca en el **nombre** localizable del estado). Para `cancelled`, preferir un *cancel‑lexicon* (`won't do`, `cancelled`, `rejected`, `abandoned`, `invalid`, `duplicate`) y fijar `resolution`; para `done`/éxito, preferir un *ship‑lexicon* (`done`, `closed`, `released`, `resolved`, `complete`) y **alejarse** del cancel‑lexicon.

El mapa también se respeta al materializar Jira en la caché local para los cinco estados lógicos. Si varios estados comparten destino, `on_review` mantiene su prioridad histórica; para otras ambigüedades se conserva la interpretación por categoría.

### Camino de transición — recorrido acotado por categorías

Como solo ves las transiciones salientes del estado **actual**, un workflow `Backlog → Selected for Dev → In Progress → Done` no ofrece arista directa a `Done`. Algoritmo: `GET /transitions` del issue vivo → aplicar la arista que reduce la distancia a la categoría objetivo (orden `new < indeterminate < done`) → re‑`GET` → repetir. Cap ~5 saltos, dedup de estados visitados (evitar bucles), parar si ninguna transición reduce distancia. **Idempotency‑first**: si hay destino explícito, comparar primero su ID/nombre con el estado actual, incluso si pertenece a otra categoría. Sin destino explícito, la categoría objetivo permite el **no‑op**. Un estado intermedio de la categoría esperada no completa un destino explícito diferente. Este recorrido no explora estados laterales modificando Jira a ciegas. Si no hay camino en N saltos → **dead‑letter** no‑fatal ("mover estado manualmente en Jira") y **jamás** se hace error del rail.

### Pantallas de transición / campos requeridos

La transición a `done` puede tener `hasScreen:true` con `resolution` requerido. Siempre `GET /transitions?expand=transitions.fields` primero; incluir `resolution`/custom fields **solo** si aparecen en esa pantalla (`required && !hasDefaultValue`). Si un custom field requerido no tiene default programable, abortar **esa** transición con gracia (dead‑letter) en vez de adivinar. El **comentario** va como op separada para que un fallo de transición no se lo lleve por delante.

### `needs_review`

Flag app‑only sin equivalente Jira. Mapeo: cuando `needs_review=true`, **no** disparar Done; en su lugar comentario + label `specrails:needs-review`. La transición a Done queda condicionada a `status==='completed' && !needs_review`. Se limpia el label en la siguiente finalización limpia (`clearWarning` en `ticket-store.ts:336-339`).

---

## 7. Hot‑swap local ↔ Jira

- **`source` es por‑ticket, no por‑tablero.** Voltear el toggle Local↔Jira cambia solo el **destino de creación** y la **fuente de lectura**; jamás re‑homologa specs existentes.
- Las specs locales pre‑existentes (sin `jira_links`) siguen siendo locales; ofrecer una acción explícita opt‑in "empujar esta spec a Jira" (crea el issue + fila `jira_links`) en vez de migrar implícitamente.
- **Write‑back gateado por snapshot‑per‑job:** la op de outbox de un job lleva el `jira_issue_id` capturado **al lanzar** (mismo patrón que el snapshot de profile). Voltear el tablero a mitad de un job no afecta el write‑back en vuelo. Esto también cubre el reinicio del server (se pierde el `railJobs` Map en memoria → re‑parsear `#id` del comando como ya hace el camino local, y re‑resolver `jira_links` por id).
- **Gating de capacidades:** helper `sourceSupports(source, feature)` (espejo de `sectionVisibleForProviders`) para ocultar Drafts / SMASH / Contract‑Layer en specs de origen Jira, sin construir la interfaz `TicketProvider` completa.

---

## 8. Sincronización

### Inbound — polling (forzado, no es un compromiso)

Webhooks descartados: el server liga `127.0.0.1` (`index.ts:552`), sin ingress público; los webhooks dinámicos de Jira Cloud exigen URL HTTPS pública + app Connect/OAuth (Basic no puede registrarlos) y **expiran cada 30 días**.

Diseño de poll:
- `POST /rest/api/3/search/jql` (el `GET /search` legacy fue **deprecado** 2024‑10‑31 y bloqueado fin‑oct‑2025). Enviar `fields` explícito, paginar con `nextPageToken`, parar en token ausente/`isLast`.
- JQL: `project = KEY AND (labels en filtro specrails) ORDER BY updated ASC`.
- **High‑water mark con solape de seguridad de 2 min** (`updated >= hw - 2min`), nunca avanzar `hw` más allá de `now - 1min`, dedup por `(issueId, updated)`. **La marca se deriva del `updated` máximo observado en los issues devueltos** (timestamps del *server de Jira*), **no** de `Date.now()` local — esto auto‑corrige el clock skew del desktop.
- `updated` tiene **resolución de minuto** y la búsqueda es eventualmente consistente → ventana ≥1 min + solape evita perder cambios del mismo minuto.
- **Reconcile completo horario** (JQL full por project+label) para detectar **borrados/moves** que no bumpean `updated`.
- **Read‑your‑write**: tras una escritura propia, usar `reconcileIssues:[id]` (consistencia fuerte para ese id) para evitar el flicker done→in_progress→done por lag de réplica.
- **El outbox es autoritativo:** el poll **no** sobrescribe un campo (sobre todo `status`) de un issue con op de outbox pendiente. Para specs en rail activo, congelar la materialización de `status` (es app‑owned durante el run); solo sincronizar campos no‑estado (description/labels).

### Outbound — outbox durable

- Drenaje en worker de fondo: **FIFO por‑issue** (una transición debe aterrizar antes que el comentario que la describe), **paralelo entre issues distintos**, con cap de concurrencia.
- **Idempotencia:** transiciones por identidad explícita ID/nombre y, sin mapa, por categoría; **comentarios** con un *self‑marker* invisible embebido en el body ADF (`[specrails:job-<id>]`) — Jira no tiene idempotencia nativa de comentarios, así que antes de re‑postear se hace `GET .../comment` y se salta si el marker ya existe. El marker dobla como filtro de auto‑eco en el poll.
- **Rate limits:** honrar `Retry-After` en 429 exacto; si ausente, backoff exponencial con jitter (base 2s, cap 30s, ~4 reintentos); respetar el techo ~20 writes/2s por issue. Token‑bucket por debajo de los burst caps.
- **Clasificación de errores:** `401` = credencial → **pausar** outbox del proyecto + banner re‑auth (no reintentar en bucle); `403` = permiso de operación concreta → dead‑letter nombrando la operación ("tu cuenta no puede transicionar en PROJ"), sin inferir fallo global; `404` sobre issue conocido = terminal (issue borrado/movido) → marcar link `orphaned`, parar la op; solo `429/5xx/timeout` son reintentables.
- **Dead‑letter visible** con reintento manual: `GET /jira/outbox`, `POST /jira/outbox/:id/retry`, indicador `JiraSyncIndicator` en UI. Un workflow‑gap o un 403 **nunca** es un drop silencioso.
- **Operaciones reemplazadas:** las transiciones fallidas con una intención posterior para el mismo issue se conservan como `superseded`, fuera del contador de atención y sin reintento. Un reintento antiguo ya encolado tampoco se aplica si una transición posterior ya terminó. Se conservan el FIFO normal y los comentarios/ediciones independientes. El panel identifica el issue y el destino, y muestra errores al cargar los estados con una acción de reintento.

---

## 9. Corner cases (87 catalogados; los críticos)

Distribución: **9 critical, 47 high, 29 medium, 2 low**. Categorías: sync (18), workflow‑mapping (16), data‑model (12), lifecycle (10), concurrency (8), auth (6), offline/permissions/rate‑limit (4 c/u), core (3), hot‑swap (2).

Los **9 críticos** y su mitigación (todos v1‑must‑handle):

1. **Sin camino de transición a la categoría objetivo** (workflow forward‑only) → BFS por saltos + dead‑letter no‑fatal, nunca error del rail.
2. **Transición Done con pantalla + `resolution` requerido** → `expand=transitions.fields`, incluir solo lo que está en pantalla; abortar con gracia si hay custom field sin default.
3. **Ambigüedad de categoría `done`** (`Released` vs `Won't Do`) → resolver de 2 niveles, mapa explícito + cancel/ship lexicon.
4. **`in_progress` de lanzamiento nunca llega a Jira** (la app no lo emite y `write_access:false` lo quita de core) → push explícito desde `rails-router.ts:293-298` + escribir `in_progress` en caché ahí mismo.
5. **Crash entre mutación de caché y enqueue de outbox** → outbox persistido **primero** en la misma txn SQLite; outbox = fuente de verdad; drenar no‑acked al arrancar.
6. **Offline en la escritura de estado al salir el job** → side‑effect Jira **nunca** inline en `onJobFinished`; solo el enqueue durable, en try/catch que no puede romper el rail; drena al reconectar.
7. **Partial write: caché en `done`, Jira sigue `In Progress`, sin fila de outbox** → mismo invariante transaccional (op registrada antes de mutar JSON) + reconcile de arranque.
8. **Proyecto Jira equivocado** (key con typo / multi‑proyecto) → validar `GET /project/{key}` en bind, mostrar nombre+lead+issue‑types para confirmación humana, scope de JQL a `project=KEY` + filtro label, guardar el **id** inmutable del project.
9. **Token expira a mitad de un rail multi‑hora** → outbox durable absorbe el 401; estado dead‑letter visible + evento WS `jira.auth_expired` + banner "Reconnect to sync N pending"; al re‑pegar token, auto‑drena (idempotencia = no‑op si ya en categoría).

Otros **high** notables: dos editores (Jira UI + TicketDetailModal) → precondición de versión/ETag, 409 no clobbea, banner "editado en Jira"; humano reabre el issue antes de que drene el `done` encolado → freshness check (si la versión cambió desde el enqueue, dead‑letter "superseded", no forzar — "el robot no pelea con el humano"); op de propose‑spec en terminal sobre proyecto Jira → materializador **quirúrgico** que nunca dropea tickets sin `jira_links`, reconcilia los `source:"propose-spec"` hacia Jira; ADF (Cloud v3) vs wiki‑string (DC v2) → branch del serializador en el límite del adapter por deployment detectado.

**Guardarraíl explícito:** **no** añadir un valor `'jira-sync'` al enum `ai_invocations.surface` — una op de sync no tiene modelo/tokens/coste y contaminaría el análisis de coste con filas `$0/null`. La telemetría de sync va en una tabla ops dedicada o solo eventos WS.

---

## 10. Plan de implementación por fases

### Fase 0 — Andamiaje y contrato (sin UI)
- Migraciones desktop‑db (`ticket_source`) y per‑project (`jira_connection`, `jira_links`, `jira_outbox`).
- `server/jira/jira-credential-store.ts` (interfaz + backend libsodium).
- `server/jira/jira-client.ts`: detección Cloud/DC en bind, Basic/Bearer, v3/v2, ADF/wiki, `{ok,data,error,status}` (modelado como `specrails-tech-client.ts`, **no** sobre `WebhookManager`).
- Escritor de `.specrails/backlog-config.json` (`provider:local`, `write_access:false`).
- Tests: cliente (mock HTTP), credential store, migraciones. Cobertura ≥ umbrales (server 80 %).

### Fase 1 — MVP (read + status round‑trip + comentario) — **el v1 enviable**
- `jira-materializer.ts`: poll `POST /search/jql` → `local-tickets.json` (merge quirúrgico, vía `mutateStore` con lock), `jira-links` por id inmutable, `#id` monotónico tombstoneado, high‑water + solape + reconcile horario.
- `jira-status-resolver.ts`: resolver 2 niveles + BFS + manejo de pantalla/resolution.
- `jira-outbox.ts` + drainer: txn única, idempotencia, FIFO‑por‑issue, Retry‑After, clasificación de errores, dead‑letter.
- **Hook A** `rails-router.ts:293-298`: encolar transición `in_progress` + escribir caché.
- **Hook B** `project-registry.ts:315-327`: encolar transición de salida + comentario de finalización.
- `jira-router.ts` (REST, gateado por flag): bind/validar conexión, `GET/POST /jira/outbox`, reintento, `mypermissions` probe.
- Eventos WS: `jira.synced`, `jira.auth_expired`, `jira.outbox_changed`, `jira.degraded` (project‑scoped).
- Cliente: toggle `ticket_source` por proyecto (Settings), badge "PROJ‑123" + estado externo en `SpecCard`/views/`TicketDetailModal`, "Ver en Jira", panel de credenciales + mapa de estados, `JiraSyncIndicator` + dead‑letter. i18n estricto (sin strings hardcoded) + tokens de tema semánticos.
- **Feature flags**: `SPECRAILS_JIRA_SECTION` (server) + `VITE_FEATURE_JIRA` (cliente), off‑por‑defecto hasta GA.
- Companion: **nada obligatorio** (pass‑through tolerante).

### Fase 2 — Robustez enterprise
- OAuth 2.0 3LO (loopback + token‑broker hospedado) detrás de la interfaz de credencial; swap de credential‑store a Tauri keychain/stronghold.
- Conflictos campo‑a‑campo bidireccionales (precondición de versión, banners de conflicto).
- Sink de comentarios Jira→local (poblar el `comments[]` dormante).
- Companion Opción B (badge Jira de primera clase, ~2 ediciones).
- Probes proactivos de permisos/expiración.

### Fase 3 — Escala / plataforma
- Relay de ingress público (vía specrails‑tech) para webhooks Jira en tiempo real (sustituye polling donde se pueda).
- Abstracción `TicketProvider` (extraer `LocalTicketProvider` + `JiraTicketProvider`) **cuando** llegue un tercer backend (GitHub Issues/Linear) — entonces es un refactor mecánico y revisable por separado, no una apuesta especulativa.

---

## 11. Por qué esto aporta alto valor al cliente enterprise

- **Adopción sin fricción de seguridad:** token en la máquina, cero backend que vea credenciales, soporta Cloud **y** Data Center (muchas enterprises siguen en DC). Ninguna revisión de "vuestro server ve nuestros tokens".
- **Respeta el workflow del cliente:** no impone estados; mapea sobre el workflow real con override explícito + fallback por categoría + BFS. Nunca rompe un rail por una transición imposible.
- **Nunca pierde una actualización ni spamea:** outbox transaccional + idempotencia → exactamente‑una‑vez observable en comentarios y transiciones, incluso con crash/offline/reintentos. El "robot no pelea con el humano".
- **Visibilidad para PMs:** el issue Jira refleja el ciclo real (In Progress al lanzar, Done al terminar) y recibe un comentario con coste/duración/PR — los stakeholders no técnicos viven en Jira y lo ven sin entrar en Specrails.
- **Hot‑swap real por proyecto** sin migración forzada ni riesgo a los proyectos locales existentes.
- **Riesgo de producto mínimo:** core congelado intacto, app móvil en App Review intacta, módulo `ticket-store.ts` crítico sin refactor. Todo detrás de feature flags.

---

## 12. Decisiones abiertas para validar antes de construir

1. **Alcance de despliegue v1:** ¿Cloud‑first (ADF, Basic) y DC detrás del tipo detectado, o DC desde el día 1? (El branch de body ADF/wiki debe existir igual si se promete DC.)
2. **Granularidad del mapa de estados:** ¿UI de mapeo explícito obligatoria en el bind, o fallback‑por‑categoría con opción de afinar? (Recomendado: fallback funcional + afinado opcional.)
3. **Comportamiento en fallo con workflow forward‑only:** ¿dejar el issue en `In Progress` en Jira por defecto (config) o intentar siempre revertir? (Recomendado: best‑effort revert + dejar‑como‑está configurable.)
4. **Companion v1:** ¿cero cambios (pass‑through) o el badge de 2 ediciones?
```
