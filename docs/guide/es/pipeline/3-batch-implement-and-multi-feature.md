# Batch implement y multifuncionalidad

Una spec a la vez está bien, pero buena parte del trabajo real viene en racimos — una funcionalidad más sus tests más su migración, o un backlog que quieres dejar limpio de una sentada. Esta página cubre cómo ejecutar varias specs juntas: el modo Batch, las oleadas por dependencias y cómo el pipeline evita que el trabajo concurrente se pise.

## Ejecutar varias specs a la vez

La forma más sencilla de ejecutar un montón de specs desde un mismo rail es el modo **Batch**:

1. **Arrastra todas las specs** que quieras a un único rail. Se apilan en la lista de specs de ese rail.
2. **Cambia el modo del rail a Batch** (el control segmentado de la cabecera del rail).
3. **Pulsa ▶ Play.**

El rail lanza **un** job `/specrails:batch-implement` que recorre todas las specs asignadas. Monitorízalo como cualquier otro job en la página Jobs — es un único job que cubre el conjunto entero, no un job por spec.

Esto importa por la **cola de un job por proyecto**. Como un proyecto solo ejecuta un job de rail a la vez, el modo Batch es también la forma más limpia de *encadenar* una lista de specs sin tener que hacer malabares con varios rails y esperar a que cada uno se vacíe.

### Implement vs Batch — ¿qué modo?

| | **Implement** | **Batch** |
|---|---|---|
| Comando | `/specrails:implement` | `/specrails:batch-implement` |
| Specs por job | Todas las del rail, tratadas como una sola unidad de trabajo | Todas las del rail, trabajadas **secuencialmente** |
| Mejor para | Un cambio fuertemente acoplado | Varias funcionalidades distintas que quieres despachar en orden |
| Ordenación | n/a | Oleadas según dependencias (mira más abajo) |

Si las specs son de verdad un único cambio, usa **Implement**. Si son una lista de funcionalidades independientes, usa **Batch** y deja que las secuencie.

## Oleadas por dependencias

El modo Batch no se limita a ejecutar las specs de arriba a abajo — calcula un **orden de ejecución según dependencias** y agrupa las specs en *oleadas*. El orquestador (`/specrails:batch-implement`) averigua qué specs dependen de cuáles y luego las planifica de modo que nada se ejecute antes que el trabajo sobre el que se construye.

Conceptualmente:

```
Oleada 1:  #2 (modelo de datos)     ← sin dependencias, se ejecuta primero
Oleada 2:  #4 (API sobre el modelo) ← espera a #2
           #5 (CLI sobre el modelo) ← espera a #2
Oleada 3:  #7 (docs de todo)        ← espera a #4 y #5
```

Dentro del job, las specs de cada oleada se implementan antes de que empiece la siguiente. Esto no lo configuras a mano — el orquestador deriva las oleadas de las propias specs. Velo desplegarse en la [vista de detalle del job](the-job-detail-view): el log en streaming va narrando en qué spec está el batch, y la cabecera de tickets muestra todas las specs que tocó el job.

## Aislamiento por worktree

Cuando se implementan varias specs en una misma ejecución, el pipeline mantiene cada unidad de trabajo aislada para que los cambios concurrentes o secuenciales no se pisen los archivos. El orquestador de batch ejecuta la implementación de cada spec en su propio contexto de trabajo limpio y después integra los resultados — así una spec a medias nunca deja tu árbol en un estado intermedio roto que la siguiente pudiera ver.

En la práctica esto significa:

- Cada spec recibe un lienzo en blanco contra el que implementar, en vez de heredar a mitad de camino las ediciones en vuelo de la spec anterior.
- Las revisiones y los pasos de ship operan sobre una instantánea coherente, no sobre un objetivo en movimiento.
- Un fallo en una oleada queda contenido — no corrompe en silencio las specs que ya se entregaron.

La app registra, por cada job, exactamente qué archivos se tocaron y qué ticket los tocó (lo verás aflorar como chips de procedencia en la sección **Code** y como una lista de "Archivos tocados por este ticket" en el modal de detalle de cada spec). Esa atribución es lo que te permite confiar en una ejecución multi-spec: siempre puedes rastrear un cambio de archivo hasta la spec que lo causó.

## Multifuncionalidad entre proyectos

Si quieres paralelismo de verdad — dos funcionalidades grandes construyéndose al mismo tiempo — repártelas **entre proyectos**, no entre rails de un mismo proyecto. Cada proyecto tiene su propia cola independiente, así que:

```
Proyecto A   ▶ Rail ejecutando la funcionalidad X   ┐
                                                    ├─ se ejecutan a la vez
Proyecto B   ▶ Rail ejecutando la funcionalidad Y   ┘
```

No hay límite global de concurrencia ni contención entre proyectos. Abre los dos, lanza un rail en cada uno y avanzarán juntos. El único freno compartido es tu tope de presupuesto, que pausa las colas por proyecto o de toda la app en cuanto el gasto del día llega al límite.

## Consejos para batches grandes

- **Agrupa specs relacionadas en un mismo rail** antes de pasar a Batch — las oleadas por dependencias solo ven lo que hay en ese rail.
- **Fija un presupuesto diario** antes de un batch grande para que una ejecución inesperadamente cara se pause sola en vez de desbocarse. Configúralo en [Presupuesto](../settings/customizing).
- **Usa el botón Comparar** en la página Jobs después para enfrentar dos ejecuciones de batch lado a lado.
- **Exporta un diagnóstico** (si la telemetría estaba activada) para obtener la instantánea exacta de perfil + plugins de todo el batch.

## A dónde ir después

- [Rails y jobs](rails-and-jobs) — el modelo de cola en profundidad.
- [La vista de detalle del job](the-job-detail-view) — mira un batch ejecutarse en vivo.
- [Elegir un motor por rail](picking-an-engine-per-rail) — ten en cuenta que Batch corre en cualquier proveedor; Ultra es solo de Claude.
