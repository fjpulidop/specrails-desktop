# Controla Specrails desde cualquier IA (servidor MCP) {#mcp-server}

Specrails puede exponerse **a sí mismo** a cualquier asistente de IA que hable el [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline o tu propio agente. Actívalo, apunta tu asistente a Specrails y podrás manejar toda la app conversando: *"lista mis proyectos", "crea una spec para login social en el proyecto de la API", "lanza el rail 0 y avísame cuando termine", "¿cuánto he gastado esta semana?"*. Tu asistente llama por debajo a las herramientas de Specrails en lugar de que tú andes haciendo clics.

Esta es la dirección opuesta a las funciones de plugins y "Mis MCPs aprobados": esas dejan que Specrails *use* otros servidores MCP; esta deja que otras apps usen **Specrails**.

## Viene activado de serie

Está **activado por defecto**: el servidor ya está en marcha la primera vez que abres la app, sin reiniciar ni tocar nada. Abre **Configuración ▸ MCP** para copiar la configuración de cliente, o para desactivarlo si no lo quieres.

Tú mantienes el control de *qué* puede hacer una IA externa mediante un conjunto de niveles de permiso:

| Nivel | Qué permite | Por defecto |
|---|---|---|
| **Lectura** | Listar e inspeccionar proyectos, specs, trabajos, analíticas… | Siempre activo (cuando MCP está habilitado) |
| **Escritura** | Crear y editar specs, cambiar la configuración y la config de los rails | Activado — desmárcalo para restringir |
| **Lanzar IA** | Acciones que ejecutan una IA y **cuestan dinero** (lanzar un rail, generar una spec, enviar un turno de chat) | Activado — desmárcalo para restringir |
| **Destructivo** | Borrar proyectos/specs/trabajos, detener trabajo en curso | Activado — desmárcalo para restringir |

Los cuatro niveles vienen concedidos de serie, así que un asistente conectado puede manejar toda la app desde el primer momento. Desmarca cualquier nivel que prefieras reservarte; si después tu asistente intenta algo que cubre ese nivel, Specrails lo rechaza con un mensaje claro que te indica qué nivel volver a activar.

## Conecta Claude Code o Codex en un paso

Abre **Ajustes ▸ MCP** y pulsa **Conectar** junto a Claude Code o Codex, o escribe un comando en una terminal:

```bash
specrails-desktop mcp connect --client claude   # o codex
```

Specrails se añade a la configuración del propio cliente, guarda una copia del archivo, no escribe ningún token de acceso y comprueba la conexión al momento (verás cuántas herramientas encontró). Repetirlo no hace daño. Después abre una sesión nueva de Claude Code o Codex. **Copiar comando** muestra el comando del propio cliente si prefieres lanzarlo tú; para otros asistentes, usa **Copiar configuración**.

Si algo no funciona, ejecuta `specrails-desktop mcp doctor`. Lo revisa todo de una vez (la app, el archivo del token de acceso, el puente y el Node que lo ejecuta, la entrada de cada cliente y una conexión real) y da la solución de cada problema. Solo mira; no cambia nada. Tras actualizar Node (por ejemplo con Homebrew), vuelve a pulsar **Conectar** si tu asistente dejó de encontrar Specrails.

**Preguntar antes de gastar** (en el mismo panel, 0,50 $ por defecto) es el importe a partir del cual un asistente conectado debe preguntarte antes de empezar un trabajo de pago. Las fusiones, los PR y los borrados siempre preguntan. Tu asistente recibe un conjunto sencillo de 15 herramientas con los siguientes pasos ya preparados, espera sin sondeos, respuestas en tu idioma y prompts como *start-my-day*, *review-waiting*, *ship-milestone* y *why-stuck*. Si algún script tuyo antiguo necesita las herramientas anteriores, desactiva **Herramientas MCP simplificadas** en el mismo panel; las misiones de Specrails no se ven afectadas.

## Exclusivamente para agentes: conecta tu cliente

Cuando una persona pida a un agente que se conecte, lee el [manual de conexión MCP](https://github.com/fjpulidop/specrails-desktop/blob/main/docs/agents/mcp.md). Cubre la conexión con un comando, el registro manual en Claude Code y Codex, la verificación y la resolución de problemas. Registrar no prueba la conexión: completa `initialize`, `tools/list` y una llamada de solo lectura.

Para ver todo de un vistazo, el asistente llama a `specrails_overview`: qué está en ejecución, qué espera por ti, los fallos recientes, el gasto de hoy y la CPU y la memoria del equipo, en una sola llamada. `specrails_inbox` lee y responde la bandeja **Pendientes**, `specrails_missions` lista tus misiones y les envía mensajes, `specrails_specs` y `specrails_rails` muestran el backlog y los rails de un proyecto, `specrails_insights` tu gasto y tus límites, y `specrails_wait` espera a que termine una ejecución en lugar de preguntar una y otra vez. Una ejecución fallida viene con su diagnóstico y el final de su registro.

Cada respuesta empieza con un breve resumen en lenguaje sencillo y los siguientes pasos posibles, con el recomendado marcado, y los errores dicen qué ha fallado y si sirve de algo reintentar. Antes de algo irreversible, o de un trabajo de pago por encima de tu límite, el asistente te enseña una vista previa y te pregunta primero. Tu sí solo vale para esa acción exacta y caduca si algo cambia mientras tanto.

Antes de actuar, el asistente puede pedir a `specrails_overview` un resumen actual de un proyecto: specs, ejecuciones y estado de Git. Las secciones no disponibles se indican de forma explícita; no significan que el proyecto esté vacío. También puede buscar y leer tu código fuente, línea a línea, sin modificarlo.

Cada sesión MCP externa conserva su propia selección de proyecto. En modo Misión, el proyecto predeterminado es el que está fijado en la conversación, que cambias desde la interfaz de la misión; una selección MCP no puede anularlo. Nombrar otro proyecto en una llamada apunta a ese proyecto a propósito.

## Qué puedes hacer con él

Unas cuantas recetas una vez que tu asistente está conectado. Todo viene activado por defecto; desmarca **Escritura** o **Lanzar IA** en Configuración ▸ MCP si por ahora prefieres que solo observe.

**Convierte en specs el trabajo de tus otras herramientas.** Si tu asistente también tiene conectados GitHub, Jira, Gmail o Slack, puede traerte el trabajo a Specrails:
> *"Coge las incidencias abiertas de GitHub de esta semana con la etiqueta 'bug', crea una spec para cada una en el proyecto de la API y lánzalas."*
>
> *"Lee mis últimos correos de feedback de clientes, agrúpalos por tema y crea una spec por tema."*

**Piloto automático nocturno.** Déjalo en marcha con la app en la bandeja y vuelve a un informe:
> *"Aquí tienes 12 ideas. Convierte cada una en una spec, lánzalas de tres en tres por los rails, vigila cada trabajo y mañana dame un resumen de lo que terminó, lo que falló y lo que costó."*

Desmarca **Destructivo** y podrá trabajar toda la noche sin borrar nada nunca.

**En todos tus proyectos.** Algo que el panel no hace por sí solo:
> *"Revisa todos mis proyectos. Dime cuáles tienen specs en el backlog y ningún rail en marcha, y arranca el de mayor prioridad en cada uno."*

**Sin manos mientras programas.** Maneja Specrails desde tu editor o por voz, sin cambiar de ventana:
> *"Lanza el rail 0 con Opus para la spec #42 y avísame cuando termine."*

**Pregunta por el coste y el historial.** Tus analíticas, en lenguaje natural:
> *"¿Dónde he gastado más en IA esta semana, por proyecto y por modelo? Enséñame los cinco specs más caras."*

**Tu standup diario.**
> *"Escribe mi standup: qué rails se ejecutaron ayer, qué se completó, qué falló y el coste total — en viñetas listas para pegar en Slack."*

**Entiende el código.** Sin necesidad de editor:
> *"¿Qué archivos tocó la spec #38? Resume en una línea qué cambió en cada uno."*

Como tu asistente lee primero la guía incorporada, rara vez necesitas nombrar herramientas ni specs — describe el resultado que quieres y él se encarga de las llamadas.

## Algunas cosas que conviene saber

- **Specrails tiene que estar en ejecución.** El servidor MCP vive dentro de la app, así que tu asistente solo puede alcanzarlo mientras Specrails esté abierto. Gracias al icono de la bandeja, cerrar la ventana lo mantiene en ejecución en segundo plano — solo **Salir** desde la bandeja (barra de menú de Mac / bandeja del sistema de Windows) lo detiene de verdad.
- **Las acciones largas se transmiten.** Lanzar un rail o generar una spec devuelve el control de inmediato y termina en segundo plano; tu asistente puede "vigilarlo" e informarte cuando se resuelva.
- **Seguridad.** El MCP usa su propio token de acceso, separado de todo lo demás, y solo escucha en tu propia máquina (loopback). El token no puede hacerse pasar por el modo Agente aportando cabeceras de nivel, proyecto o conversación: el agente integrado usa una capacidad privada, de corta duración y emitida por el servidor. Puedes copiar o regenerar el token acotado en cualquier momento desde el panel.
- **No expuesto (v1).** Por seguridad, los clientes MCP externos no pueden ejecutar comandos de shell en bruto en la terminal, usar el navegador integrado, editar archivos dentro de la app ni instalar prerrequisitos del sistema. El modo Agente tiene una vía autenticada aparte para comandos largos en segundo plano confirmados con el permiso Autónomo; los clientes externos no pueden obtenerla activando Destructivo. Todo lo demás que *gestiona* Specrails está disponible.

Puedes desactivar MCP en cualquier momento desde el mismo panel — tu asistente simplemente pierde el acceso y nada más cambia.
