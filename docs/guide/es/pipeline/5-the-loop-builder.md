# El Loop Builder

Un **rail ejecuta un Loop**. Los loops integrados (`Implement`, `Batch`, `Freestyle`) cubren los casos del día a día, pero el **Loop Builder** te permite diseñar el tuyo propio — un editor visual al estilo n8n para automatizaciones que se repiten hasta cumplir un objetivo. Esta página explica qué es un loop, cómo construir uno y cómo ejecutarlo en un rail.

## Loops y rails — la relación

Un **loop** es la *receta* del trabajo; un **rail** es el *carril* que la ejecuta contra tus specs.

```
   Loop Builder (barra lateral izq.)       Rails (derecha)
   ───────────────────────────             ─────────────
   Implement   (integrado)                 Rail 1
   Batch       (integrado)     elige en ►     Loop: Verify-until-green
   Freestyle   (integrado)                    ▶ Play
   Verify-until-green (tuyo)
```

- Los loops viven en la sección **Loops** (barra lateral izquierda, junto a tus proyectos) — son **globales**, compartidos entre todos los proyectos.
- Un rail **elige un loop** en su cabecera (el selector de Loop) y lo ejecuta cuando pulsas Play.
- El **rail** decide el proveedor, el modelo y el esfuerzo de razonamiento — *no* los pasos del loop. El mismo loop se ejecuta en Claude, Codex o Gemini según el rail.

Así que: construye un loop una vez y luego elígelo en cualquier rail de cualquier proyecto.

## Abrir el builder

Pulsa **Loops** en la barra lateral izquierda para ver la biblioteca: los tres loops integrados más los tuyos. Abre uno para verlo, o pulsa **New loop** para empezar desde un lienzo en blanco.

No puedes editar fácilmente un integrado directamente — en su lugar, hazle **Fork**. Eso te da una copia editable de un grafo que funciona desde la que partir, que es la forma más fácil de aprender.

## De qué se compone un loop

Un loop es un grafo de **nodos** conectados por **aristas** (las flechas). Cada nodo es un paso:

| Nodo | Qué hace |
|------|--------------|
| **Start** | Donde empieza la ejecución. Exactamente uno por loop. |
| **AI Step** | Ejecuta un turno de IA — un prompt que escribes, o un *comando mágico* como `{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`. Aquí es donde sucede el trabajo real. |
| **Shell** | Ejecuta un comando de shell (p. ej. `npm test`) y captura su salida para pasos posteriores. |
| **Loop Decider** | El cerebro de un loop. En cada pasada lee un **objetivo** que escribes y decide **continue** (volver atrás e intentarlo de nuevo) o **stop** (salir). Esto es lo que hace posible *verify → fix → verify hasta que esté en verde*. |
| **End** | Un nodo terminal. Marca la ejecución como éxito o fallo. |

Las aristas conectan los pasos en orden. El **Loop Decider** tiene dos salidas etiquetadas — **continue** y **stop** — así que cableas "aún no terminado" de vuelta al trabajo y "terminado" hacia un End.

### Escribir el texto de un paso

Dentro de cualquier AI Step o Decider puedes referenciar:

- **Datos de spec** — `{{spec.title}}`, `{{spec.description}}`, `{{spec.ids}}` (los IDs de ticket del rail). Se rellenan a partir de la(s) spec(s) del rail en tiempo de ejecución.
- **Comandos mágicos** — `{{cmd:implement}}` y compañía se expanden al comando de pipeline correspondiente.
- **Constantes** — `{{const:NAME}}` toma de la **biblioteca de constantes** global (arrástralas desde la paleta). Los centinelas integrados, como los marcadores PASS/FAIL de verificación, están siempre disponibles; puedes añadir los tuyos y reutilizarlos en todos los loops.

## Mantener un loop acotado

Un loop que nunca para gastaría dinero para siempre, así que cada ejecución tiene tres salvaguardas (se fijan en la barra de herramientas del builder):

| Salvaguarda | Qué hace |
|-------|--------------|
| **Max iterations** | Tope duro de cuántas veces puede el Decider volver atrás, sin importar su veredicto. |
| **Timeout (min)** | Límite de tiempo real para toda la ejecución. |
| **Max cost ($)** | *Opcional.* Detiene el loop una vez el coste acumulado cruza tu presupuesto. Se comprueba **entre pasos** (el coste de un paso solo se conoce cuando termina), así que puede sobrepasar por un paso. En Claude el coste es exacto; en Codex y Gemini es una estimación. Déjalo vacío para no poner tope. |

## Construir con confianza

El builder te ayuda a dejar un loop correcto antes de que se ejecute siquiera:

- **Validación en vivo** — los problemas (sin Start, un paso huérfano, un prompt vacío, un Decider con ramas faltantes) se señalan en el lienzo y en un panel de problemas.
- **Vista previa de dry-run** — resuelve el texto exacto de cada paso (datos de spec, constantes y comandos todos expandidos) **sin lanzar nada**, así que ves con precisión qué enviaría cada paso.
- **Auto-arrange** — ordena el lienzo en vertical, horizontal o como cuadrícula; tu elección se guarda por loop.
- **Copiar / pegar** — `Cmd/Ctrl + C` / `V` para copiar pasos dentro de un loop o entre loops.
- **Importar / exportar** — guarda loops en un archivo `.json` e impórtalos de vuelta (los nombres duplicados se omiten, el resto se importa).
- **Renombrar pasos** — dale a cada nodo una etiqueta personalizada para que el grafo se lea con claridad.

## Publicar y ejecutar

Un loop empieza como **Draft**. Cuando el grafo es válido, **Publish** — los loops publicados son los que aparecen en el selector de Loop de un rail. (Despublícalo para sacarlo de circulación sin borrarlo.)

Para ejecutar un loop personalizado:

1. Abre un proyecto y arrastra una spec a un rail.
2. En la cabecera del rail, abre el **selector de Loop** y elige tu loop publicado.
3. Pulsa **▶ Play**.

La ejecución se transmite en vivo en la vista **Jobs** con las mismas métricas y el mismo seguimiento de coste que cualquier trabajo de rail — y su log estrena un **explorador de pasos** dedicado: un mapa en vivo de tu grafo con una caja plegable por paso, que sigue al paso en ejecución mientras el loop avanza (ver [La vista de Detalle del trabajo](the-job-detail-view)). En Claude, cada **Paso de IA** es además una sesión en vivo: envíale mensajes desde el compositor del detalle del job para dirigirlo a mitad de paso (entre pasos el compositor espera brevemente, y **Asentar este paso** hace avanzar el loop con lo que el paso produjo). Un loop que se detiene porque alcanzó su tope de iteraciones o de coste se reporta con ese resultado en lugar de un éxito a secas.

> **Aviso mientras se ejecuta un loop.** No puedes editar ni borrar un loop mientras una de sus ejecuciones está en curso — detén la ejecución primero.

## A dónde ir después

- [Rails y trabajos](rails-and-jobs) — lanzar rails y la cola de trabajos.
- [La vista de Detalle del trabajo](the-job-detail-view) — ver una ejecución en vivo.
- [Elegir un motor por rail](picking-an-engine-per-rail) — el rail (no el loop) elige el proveedor.
