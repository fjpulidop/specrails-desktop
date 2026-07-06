# Batch implement y multifuncionalidad

Una spec a la vez está bien, pero buena parte del trabajo real viene en racimos — una funcionalidad más sus tests más su migración, o un backlog que quieres dejar limpio de una sentada. Esta página cubre cómo ejecutar varias specs juntas: el modo Batch, las oleadas por dependencias y cómo el pipeline evita que el trabajo concurrente se pise.

## Ejecutar varias specs a la vez

La forma más sencilla de ejecutar un montón de specs desde un mismo rail es el modo **Batch**:

1. **Arrastra todas las specs** que quieras a un único rail. Se apilan en la lista de specs de ese rail.
2. **Cambia el modo del rail a Batch** (el control segmentado de la cabecera del rail).
3. **Pulsa ▶ Play.**

El rail lanza **un** job `/specrails:batch-implement` que recorre todas las specs asignadas. Monitorízalo como cualquier otro job en la página Jobs — es un único job que cubre el conjunto entero, no un job por spec.

El modo Batch sigue siendo la forma más limpia de *secuenciar* specs relacionadas porque mantiene su orden de dependencias dentro de un solo rail. Si las specs son independientes, también puedes repartirlas entre varios rails: los rails respaldados por git se ejecutan en paralelo y cada uno recibe su propio worktree aislado.

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

## Aislamiento por worktree y cómo se entrega el trabajo

Cuando se implementan varias specs en una misma ejecución, el pipeline mantiene cada unidad de trabajo aislada para que los cambios concurrentes o secuenciales no se pisen los archivos. La implementación de cada spec se ejecuta en su propio **git worktree** limpio — un checkout aparte que comparte el historial de tu repositorio pero que nunca toca tu árbol de trabajo mientras la IA trabaja.

Cuando la ejecución termina, **no se sube nada y todavía no se abre ninguna pull request**. El trabajo queda commiteado a salvo en sus ramas aisladas, las specs pasan a un nuevo estado **En revisión**, y specrails **te pregunta primero**: en el rail aparece una barra de decisión persistente con **Crear PR** — una única pull request en borrador partiendo de la rama de integración que hayas designado para tu proyecto (configúrala en **Ajustes → Rama de integración**; por defecto es la rama por defecto de tu repositorio), combinada a través de todas las specs del rail — y **Descartar**. specrails **nunca hace merge ni commitea directamente sobre tu rama de integración** — tú decides si siquiera existe una PR, y el merge lo decide una persona. Es el traspaso seguro: specrails produce la pull request solo cuando tú lo dices, y tus ingenieros la revisan y la mergean en GitHub como ya lo hacen.

Si relanzas una spec que ya está en revisión y tiene una pull request abierta, Specrails lo trata como trabajo de seguimiento. Detecta la PR activa desde su propio registro de entrega o desde referencias de GitHub/Jira, hace checkout de la rama head de esa PR, commitea ahí los nuevos cambios y vuelve a mostrar la misma tarjeta de PR. El trabajo nuevo sigue empezando desde la rama de integración.

En la práctica esto significa:

- Cada spec recibe un lienzo en blanco contra el que implementar, en vez de heredar a mitad de camino las ediciones en vuelo de la spec anterior.
- Tu árbol de trabajo nunca se modifica mientras la ejecución está en curso — nada aterriza hasta que tú lo digas.
- Cuando la ejecución termina, las specs muestran una insignia **En revisión** y el rail te hace la pregunta: **Crear PR** para abrir la pull request en borrador combinada, o **Descartar** para limpiar las ramas y devolver las specs al backlog. Si lanzaste el rail desde el chat del agente, la misma pregunta aparece como una tarjeta en esa conversación — responde en cualquiera de los dos sitios: ambos se mantienen sincronizados.
- Una vez creada, **Abrir PR** la muestra, **Publicar** la abre a revisión y la entrega a la revisión habitual de GitHub de tu equipo, y **Comprobar merge** pasa las specs a Hecho en cuanto tu equipo la haya mergeado.
- Si las ramas aisladas no se pueden combinar limpiamente al crear la PR, specrails se detiene de forma segura y deja las ramas para una persona — nunca fuerza un merge roto sobre tu base. Puedes reintentar o descartar desde la misma barra.

> Crear o continuar una PR requiere un repositorio git, la CLI de GitHub (`gh`) autenticada y un remoto configurado. Sin `gh` o sin remoto, specrails igualmente mantiene el trabajo commiteado en una rama desde la que puedes abrir tú mismo una pull request — no se pierde nada, y la barra de decisión te permite reintentar. Sin git en absoluto, no hay grafo de ramas que continuar: el rail se ejecuta en la carpeta compartida y no aparece ninguna tarjeta de PR. Para volver al comportamiento anterior (integrar en local en vez de preguntar), define `SPECRAILS_RAIL_DELIVER_PR=0`.

## Multifuncionalidad entre proyectos

Si quieres paralelismo de verdad, usa varios rails para specs independientes dentro del mismo proyecto respaldado por git, o reparte el trabajo entre proyectos. Cada rail activo recibe su propio worktree aislado, así que:

```
Proyecto A   ▶ Rail ejecutando la funcionalidad X   ┐
                                                    ├─ se ejecutan a la vez
Proyecto B   ▶ Rail ejecutando la funcionalidad Y   ┘
```

No hay límite global de concurrencia que ajustar. Abre los proyectos o rails que necesites, lánzalos y avanzarán juntos. El único freno compartido es tu tope de presupuesto, que pausa las colas por proyecto o de toda la app en cuanto el gasto del día llega al límite.

## Consejos para batches grandes

- **Agrupa specs relacionadas en un mismo rail** antes de pasar a Batch — las oleadas por dependencias solo ven lo que hay en ese rail.
- **Fija un presupuesto diario** antes de un batch grande para que una ejecución inesperadamente cara se pause sola en vez de desbocarse. Configúralo en [Presupuesto](../settings/customizing).
- **Usa el botón Comparar** en la página Jobs después para enfrentar dos ejecuciones de batch lado a lado.
- **Exporta un diagnóstico** (si la telemetría estaba activada) para obtener la instantánea exacta de perfil + plugins de todo el batch.

## A dónde ir después

- [Rails y jobs](rails-and-jobs) — el modelo de cola en profundidad.
- [La vista de detalle del job](the-job-detail-view) — mira un batch ejecutarse en vivo.
- [Elegir un motor por rail](picking-an-engine-per-rail) — ten en cuenta que Batch corre en cualquier proveedor; Freestyle es solo de Claude.
