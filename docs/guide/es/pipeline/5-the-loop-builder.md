# El Loop Builder

## Workflows de Core

Con un motor de Core compatible, un canvas nuevo muestra las diecisiete piezas del catálogo instalado. Haz clic o arrastra una pieza al canvas, selecciónala y completa su formulario. Los proveedores y roles pertenecen al proyecto activo. Cada salida indica un resultado posible: conéctala a otra pieza o a Fin. Cada resultado admite una conexión.

El catálogo incluye prompts, turnos de rol, decisiones, condiciones, verificación, shell, validación y archivo de OpenSpec, aprobaciones, preguntas, pausas, mapas, uniones, componentes, implementación y Fin. Los formularios permiten editar campos opcionales, objetos, listas y diccionarios. **Opciones del workflow** incluye límites de tokens y transiciones y políticas de concurrencia. El límite explícito de transiciones cuenta también las visitas dentro de componentes y ramas.

Crea un cuerpo reutilizable en **Componentes**, declara sus variables de entrada y resultados y selecciónalo en una pieza Componente o Mapear. La navegación vuelve al canvas principal sin perder cambios. El Fin de un componente tiene un resultado de negocio y un `exit` opcional que coincide con una salida declarada.

**Publicar** envía el borrador a Core. Los errores aparecen en el panel de problemas y señalan los nodos afectados. El lanzamiento vuelve a validar la configuración efectiva del proyecto. Core controla el formato y su hash. Si no está disponible, actualiza Core; los loops antiguos conservan su editor y ejecución.

Las secciones siguientes describen los nodos antiguos de Desktop y su uso en rails.

Un **rail ejecuta un Loop**. Los loops integrados (`Implement`, `Freestyle`, `SDD Quick (OpenSpec)`) cubren los casos del día a día, pero el **Loop Builder** te permite diseñar el tuyo propio — un editor visual al estilo n8n para automatizaciones que se repiten hasta cumplir un objetivo. Esta página explica qué es un loop, cómo construir uno y cómo ejecutarlo en un rail.

## Loops y rails — la relación

Un **loop** es la *receta* del trabajo; un **rail** es el *carril* que la ejecuta contra tus specs.

```
   Loop Builder (barra lateral izq.)       Rails (derecha)
   ───────────────────────────             ─────────────
   Implement   (integrado)                 Rail 1
   Freestyle   (integrado)     elige en ►     Loop: Verify-until-green
   Verify-until-green (tuyo)                    ▶ Play
```

- Los loops viven en la sección **Loops** (barra lateral izquierda, junto a tus proyectos) — son **globales**, compartidos entre todos los proyectos.
- Un rail **elige un loop** en su cabecera (el selector de Loop) y lo ejecuta cuando pulsas Play.
- El **rail** decide el proveedor, modelo y esfuerzo compatible. Un loop compatible puede ejecutarse en Claude, Codex, Gemini o Kimi.

Así que: construye un loop una vez y luego elígelo en cualquier rail de cualquier proyecto.

## Abrir el builder

Pulsa **Loops** en la barra lateral izquierda para ver la biblioteca: los tres loops integrados más los tuyos. Abre uno para verlo, o pulsa **New loop** para empezar desde un lienzo en blanco.

Los loops integrados son loops reales y editables. Ábrelo con **Edit** y cámbialo como cualquier otro loop: al guardar pasa a Borrador y **Publish** aplica tu versión en **todos los rails, lanzamientos desde el chat del agente y Companion que usan ese integrado**. Mientras tu edición sea un Borrador, los rails siguen ejecutando la última versión publicada, así que nada se rompe a mitad de edición. **Restaurar original** (en la tarjeta o en el builder) devuelve el integrado a su versión por defecto; los integrados no se pueden borrar. ¿Prefieres una copia aparte? Usa **Duplicate**: crea un loop normal y deja el integrado intacto.

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

> **Kimi ejecuta loops con pasos AI/shell, pero no con Loop Decider.** El
> veredicto es pure-output y `kimi -p` no puede imponer su límite sin
> herramientas; el run se rechaza antes del primer paso.

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
| **Max cost ($)** | *Opcional.* Claude aporta coste; Codex/Gemini usan estimación. Kimi no emite coste USD autoritativo. |

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

Cuando el Core seleccionado expone límites por invocación, las piezas de prompt, rol y decider ofrecen `timeoutMs` e `idleTimeoutMs`. Usa `0` para desactivar ese temporizador del paso, o elimina el campo para heredar el valor predeterminado. Los presupuestos del workflow completo y la cancelación siguen activos. Si una verificación plantea una pregunta bloqueante, espera tu respuesta antes de aceptar un resultado correcto.

Cuando un grafo antiguo guardado se sustituye por primera vez por piezas de Core, se conserva el grafo original. La biblioteca ofrece entonces **Exportar grafo original**. La exportación tiene un nombre distinto para poder importarla como un borrador independiente sin sustituir el workflow actual. La conversión y las ediciones posteriores nunca publican el loop automáticamente.

Usa **Asignar variables** para conservar estado durante una pausa: asigna valores JSON tipados o ajusta un contador entero existente. Esta pieza no realiza llamadas a la IA. Las actualizaciones se guardan juntas; un contador inválido deja todas las variables intactas. Las variables de un componente mapeado permanecen dentro de ese componente.

En un Decider, **Continuar mientras se cumpla esta condición** protege el trabajo obligatorio pendiente. Por ejemplo, `$vars.failedPass == true` convierte una propuesta de detenerse en continuar hasta que el workflow quite esa marca. La decisión se ejecuta igualmente y el trabajo repetido sin cambios sigue sujeto al límite de falta de progreso. Las preguntas humanas siguen pausando la ejecución hasta recibir respuesta.

Para migrar un loop guardado del motor anterior, elige **Convertir a Core** en la biblioteca. Selecciona el repositorio original si un paso shell no tiene un ámbito explícito. La conversión valida el grafo y guarda un borrador con una copia exportable del original. Revisa las conexiones y publica explícitamente. No se pueden convertir loops en ejecución; se conservan las ediciones en conflicto. Los pasos que escriben requieren comandos reales de verificación y Quick SDD utiliza el OpenSpec incluido en Core. Actualiza Core si la conversión no está disponible.

Para ver qué loops guardados necesitan atención, abre **Comprobación de migración a Core** en la biblioteca de loops y elige **Comprobar**. Muestra los loops que el Core instalado rechaza, los que están listos para convertir y los que necesitan un repositorio u otro arreglo. Nunca convierte ni publica nada por su cuenta.

Un Core futuro que solo ejecute flujos de Core no lanzará en un rail un loop sin convertir. Desktop muestra un mensaje que te lleva a **Convertir a Core**, en vez de empezar una ejecución que fallaría a mitad. Las ejecuciones ya iniciadas conservan la versión de Core que las creó.
