# Borradores y la Contract Layer

Esta página cubre dos formas de sacarle más partido a tus specs: los **borradores** (guardar una idea en curso para retomarla más tarde) y la **Contract Layer** (un enriquecimiento opcional que hace las specs más precisas para el pipeline de IA).

## Borradores: guardar una idea en curso

Un **borrador** es una conversación de [Explore](add-spec-explore-mode.md) en curso guardada como spec. Te permite parar a mitad de pensamiento sin perder nada y volver cuando estés listo.

### Guardar un borrador

Mientras estás en una conversación de Explore, haz clic en **Guardar como borrador** (disponible en cuanto hayas enviado al menos un mensaje). La app:

- Crea una spec con estado **Borrador** en tu tablero.
- Le pone un título automáticamente si no estableciste uno (un resumen breve de la conversación).
- La vincula de vuelta a la conversación, para conservar todo el historial del chat.

Guardar es idempotente: si guardas la misma conversación dos veces, actualiza el borrador existente en lugar de crear un duplicado.

### Cómo se ven los borradores en el tablero

Los borradores viven en el mismo grupo activo que tus specs Por hacer: no hay una columna separada. Los distinguirás por:

- Una píldora `Draft` donde normalmente está la píldora de prioridad.
- Un borde con un tinte sutil en la tarjeta.

Un borrador puede *no tener prioridad*: la prioridad la defines cuando lo confirmas como una spec real.

### Retomar un borrador

Para continuar donde lo dejaste:

1. Abre el borrador desde el tablero.
2. Haz clic en **Seguir editando** en el modal de detalle.
3. La conversación original de Explore se reabre con su historial de chat completo, y el panel del borrador en vivo se rellena con todo lo que habías ido dando forma.
4. Sigue hablando. Cuando termines, **Crear spec** promueve el borrador a una spec real (estado **Por hacer**, con la prioridad que elijas).

### Descartar un borrador

Los borradores **nunca se borran automáticamente**. Solo desaparecen cuando los descartas explícitamente, o cuando los confirmas en un estado real. Descartar un borrador también limpia su conversación vinculada cuando nada más la referencia.

> Consejo: cuando no tengas claro si una spec merece la pena, guárdala como borrador y déjala reposar. Ábrela a la mañana siguiente, echa un vistazo a la descripción y decide con la mente fresca.

## La Contract Layer: precisión para el pipeline

La **Contract Layer** es un enriquecimiento opcional que añade un bloque estructurado a la descripción de una spec. Su función es eliminar las conjeturas para los agentes de IA que implementan la spec, de modo que reutilicen los nombres correctos, respeten las formas de datos esperadas y toquen los archivos adecuados en lugar de inventar los suyos.

### Qué añade

La Contract Layer consta de cinco secciones breves que se añaden a la spec:

- **Naming Contract**: los identificadores exactos (funciones, campos, rutas) que la implementación debe reutilizar.
- **Data Shapes**: los payloads tipo JSON involucrados.
- **State Machine**: las transiciones o estados por los que pasa la funcionalidad.
- **Invariants**: propiedades que siempre deben cumplirse.
- **File Touch List**: los archivos que se espera que la implementación edite.

Piénsalo como entregarle al pipeline un plano preciso en lugar de un boceto. Resulta especialmente valioso para specs que se conectan con código existente, donde que la IA adivine un nombre o una forma provocaría retrabajo.

### Cómo añadirla

Hay tres formas de aplicar la Contract Layer:

- **Modo Quick**: activa el interruptor **Enriquecer con Contract Layer** antes de generar. Tu última elección se recuerda por proyecto. (Consulta [Añadir spec — Modo Quick](add-spec-quick-mode.md).)
- **Modo Explore**: elige el preset de contexto **Max** o **Desktop** (que ejecutan el enriquecimiento automáticamente al confirmar), o abre **Ajuste fino** y actívalo a mano. (Consulta [Añadir spec — Modo Explore](add-spec-explore-mode.md).)
- **En una spec existente**: abre el modal de detalle de la spec y vuelve a ejecutar el enriquecimiento desde ahí.

### Dónde aparece

Una vez que una spec tiene Contract Layer, el modal de detalle la muestra como un bloque desplegable con una insignia tipo `3/5 populated`, que te indica cuántas de las cinco secciones se han rellenado realmente (algunas funcionalidades simplemente no tienen, por ejemplo, una máquina de estados, y esas secciones se marcan como no aplicables). Despliégalo para leer el contrato completo; pliégalo para mantener la descripción ordenada.

Si el enriquecimiento alguna vez falla al ejecutarse, la app muestra una notificación con una acción **Reintentar** para que puedas volver a lanzarlo.

### ¿Siempre merece la pena?

No siempre. Para una spec pequeña y autocontenida, la IA puede implementarla bien sin ella. La Contract Layer demuestra su valor en specs que se integran estrechamente con código existente, donde los nombres y formas exactos importan: ahí es cuando fijar el contrato por adelantado te ahorra una ronda de correcciones más tarde.

## Adónde ir después

- [Añadir spec — Modo Explore](add-spec-explore-mode.md): de donde salen los borradores.
- [Añadir spec — Modo Quick](add-spec-quick-mode.md): el interruptor de Contract Layer en el modo Quick.
- [Ejecutar pipelines](running-pipelines.md): implementa una spec una vez esté lista.
