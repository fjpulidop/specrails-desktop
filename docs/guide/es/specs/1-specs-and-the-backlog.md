# Specs y el backlog

Una **spec** es la unidad de trabajo que implementa el pipeline de IA. Piénsala como un ticket: un título, una descripción de lo que quieres conseguir, una prioridad y, opcionalmente, etiquetas. Cuando lanzas el pipeline, los agentes de IA leen la spec y actúan en consecuencia, así que una spec clara es la pieza más importante para obtener un buen resultado.

A veces a las specs se las llama **tickets** en la app: las dos palabras significan lo mismo.

## El tablero

Cada proyecto se abre en su **Dashboard**, que muestra el **SpecsBoard**: la lista de todas las specs del proyecto. Este es tu backlog. Desde aquí creas specs nuevas, defines su prioridad, las arrastras a un rail para implementarlas y ves cómo cambia su estado a medida que avanza el trabajo.

El tablero tiene dos modos de vista, que se cambian con un botón de la barra de herramientas y se recuerdan por proyecto:

- **Vista post-it** (la predeterminada): tarjetas con resúmenes breves.
- **Vista de lista**: filas compactas de una sola línea.

El **selector de estados** de la barra de herramientas muestra cada estado como su propio chip con un contador en vivo — más dos grupos inteligentes: **Activas** (el valor por defecto — todo lo que sigue en movimiento: borradores, por hacer, en curso y en revisión) y **Todos** (todo, con Hecho fijado al final). Tu selección se recuerda por proyecto y se refleja en la URL, así que un refresco o un enlace compartido restaura la vista exacta. En proyectos conectados a Jira aparece además un desplegable de **estado de Jira**, que lista los estados *reales* del flujo de trabajo del tablero (sus nombres tal cual, p. ej. "Code Review", cada uno con su contador en vivo) agrupados bajo el estado al que mapean — se combina con los chips de estado. También puedes filtrar por **etiqueta**, y ordenar por **Por defecto**, **Ticket #** o **Prioridad** (cada uno con un interruptor ascendente/descendente).

## Estados

Una spec recorre un pequeño conjunto de estados. El tablero le da a cada uno una señal visual coherente para que puedas leer el estado de tu backlog de un vistazo:

| Estado | Qué significa |
|--------|---------------|
| **Borrador** | Una idea en curso guardada desde una conversación de Explore. Todavía no está lista para implementar; puedes volver y seguir dándole forma. Muestra una píldora `Draft`. |
| **Por hacer** | Lista para retomarse. Aquí es donde aterriza una spec terminada cuando la creas. |
| **En curso** | El pipeline está trabajando en ella ahora mismo (un punto azul pulsante). |
| **En revisión** | Implementada — cada ejecución terminada aparca aquí sus specs para tu aprobación: fusiona la PR en borrador o muévelas tú mismo (una píldora ámbar). |
| **Hecho** | Aprobada — su PR se fusionó, o la moviste aquí tú mismo (una marca de verificación verde). |
| **Cancelado** | Abandonada (una X roja). |

Los borradores viven en el mismo grupo activo que las specs Por hacer (no hay una columna separada para ellos), pero llevan un borde con un tinte sutil y una píldora `Draft` para que se distingan fácilmente. Consulta [Borradores y la Contract Layer](drafts-and-contract-layer.md) para conocer todos los detalles sobre los borradores.

## Prioridades

Toda spec que no sea un borrador tiene una prioridad: **Crítica**, **Alta**, **Media** o **Baja**. La prioridad es puramente una herramienta de organización: te ayuda a decidir qué implementar a continuación y te permite ordenar el tablero. La defines al crear una spec y puedes cambiarla en cualquier momento haciendo clic derecho en la tarjeta de la spec y eligiendo **Set priority**.

Los borradores son la única excepción: un borrador puede *no* tener ninguna prioridad, porque todavía es una idea en curso. La prioridad queda fijada cuando confirmas el borrador como una spec real.

## Crear una spec

Para crear una spec, haz clic en **Añadir** (el botón Más de la barra de herramientas del SpecsBoard). Se abre el diálogo **Añadir spec** con varias formas de trabajar:

- **Modo Quick**: describes lo que quieres y la IA escribe la spec completa de una sola vez. Consulta [Añadir spec — Modo Quick](add-spec-quick-mode.md).
- **Modo Explore**: conversas con la IA y esta te ayuda a dar forma a la spec turno a turno. Consulta [Añadir spec — Modo Explore](add-spec-explore-mode.md).
- **Modo Raw**: lo que escribas se guarda tal cual como una spec, sin intervención de la IA. Úsalo cuando ya tengas el texto de la spec escrito.

A cuál recurrir depende de lo clara que tengas ya la idea. ¿Sabes exactamente lo que quieres? Quick. ¿Todavía le estás dando vueltas? Explore. ¿Ya tienes el texto? Raw.

## Adónde ir después

- [Añadir spec — Modo Quick](add-spec-quick-mode.md): la forma más rápida de convertir una idea en una spec.
- [Añadir spec — Modo Explore](add-spec-explore-mode.md): da forma a una spec conversando.
- [Borradores y la Contract Layer](drafts-and-contract-layer.md): guarda el trabajo en curso y enriquece las specs para el pipeline.
