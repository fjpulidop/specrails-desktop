# Controla Specrails desde cualquier IA (servidor MCP)

Specrails puede exponerse **a sí mismo** a cualquier asistente de IA que hable el [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline o tu propio agente. Actívalo, apunta tu asistente a Specrails y podrás manejar toda la app conversando: *"lista mis proyectos", "crea una spec para login social en el proyecto de la API", "lanza el rail 0 y avísame cuando termine", "¿cuánto he gastado esta semana?"*. Tu asistente llama por debajo a las herramientas de Specrails en lugar de que tú andes haciendo clics.

Esta es la dirección opuesta a las funciones de plugins y "Mis MCPs aprobados": esas dejan que Specrails *use* otros servidores MCP; esta deja que otras apps usen **Specrails**.

## Cómo activarlo

Está **desactivado por defecto**. Abre **Configuración ▸ MCP** y activa **Habilitar MCP**. Eso es todo — el servidor arranca de inmediato, sin reiniciar.

Tú mantienes el control de *qué* puede hacer una IA externa mediante un conjunto de niveles de permiso:

| Nivel | Qué permite | Por defecto |
|---|---|---|
| **Lectura** | Listar e inspeccionar proyectos, specs, trabajos, analíticas… | Siempre activo (cuando MCP está habilitado) |
| **Escritura** | Crear y editar specs, cambiar la configuración y la config de los rails | Desactivado — actívalo tú |
| **Lanzar IA** | Acciones que ejecutan una IA y **cuestan dinero** (lanzar un rail, generar una spec, enviar un turno de chat) | Desactivado — actívalo tú |
| **Destructivo** | Borrar proyectos/specs/trabajos, detener trabajo en curso | Desactivado — actívalo tú |

Si tu asistente intenta algo que cubre un nivel desactivado, Specrails lo rechaza con un mensaje claro que te indica qué nivel activar. Así puedes empezar en modo solo lectura y abrir exactamente lo que necesites.

## Conectar tu asistente

El panel muestra un bloque de configuración listo para pegar. La vía más sencilla y universal es el **puente** (bridge) incluido (`specrails-mcp`): tu asistente lo ejecuta y este se encarga de retransmitir a Specrails por ti. El puente lee el token de acceso localmente, así que **el token nunca aparece en la configuración de tu asistente**.

En un cliente como Claude Desktop o Cursor, la configuración tiene este aspecto:

```json
{ "mcpServers": { "specrails": { "command": "specrails-mcp" } } }
```

Los clientes que admiten servidores MCP remotos por HTTP pueden, en su lugar, apuntar directamente a `http://127.0.0.1:4200/api/mcp` con el token del panel.

### Desde la terminal: Claude Code, Gemini CLI, Codex CLI

Copia tu token desde **Ajustes ▸ MCP ▸ Copiar token** y después:

```bash
# Claude Code
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <tu token>"

# Gemini CLI
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <tu token>"

# Codex CLI (stdio — registra el comando del bridge que muestra Ajustes ▸ MCP)
codex mcp add specrails -- <comando del bridge de Ajustes ▸ MCP>
```

La cabecera `Authorization: Bearer <token>` también funciona. Si cambiaste el puerto de la app, sustituye `4200` por el tuyo.

Una vez conectado, tu asistente ve unas **18 herramientas** que cubren toda la app — proyectos, specs, rails y trabajos, chat/Explore, agentes, plugins, Jira, loops, el explorador de código, analíticas, configuración — más una herramienta de **guía** incorporada que lee primero para entender cómo funciona Specrails sin que tú tengas que explicar nada.

## Qué puedes hacer con él

Unas cuantas recetas una vez que tu asistente está conectado. Empieza con **Lectura** activado y, cuando quieras que de verdad cree y lance trabajo, activa **Escritura** y **Lanzar IA**.

**Convierte en specs el trabajo de tus otras herramientas.** Si tu asistente también tiene conectados GitHub, Jira, Gmail o Slack, puede traerte el trabajo a Specrails:
> *"Coge las incidencias abiertas de GitHub de esta semana con la etiqueta 'bug', crea una spec para cada una en el proyecto de la API y lánzalas."*
>
> *"Lee mis últimos correos de feedback de clientes, agrúpalos por tema y crea una spec por tema."*

**Piloto automático nocturno.** Déjalo en marcha con la app en la bandeja y vuelve a un informe:
> *"Aquí tienes 12 ideas. Convierte cada una en una spec, lánzalas de tres en tres por los rails, vigila cada trabajo y mañana dame un resumen de lo que terminó, lo que falló y lo que costó."*

Mantén **Destructivo** desactivado y podrá trabajar toda la noche sin borrar nada nunca.

**En todos tus proyectos.** Algo que el panel no hace por sí solo:
> *"Revisa todos mis proyectos. Dime cuáles tienen specs en el backlog y ningún rail en marcha, y arranca el de mayor prioridad en cada uno."*

**Sin manos mientras programas.** Maneja Specrails desde tu editor o por voz, sin cambiar de ventana:
> *"Lanza el rail 0 en modo Freestyle con Opus para el ticket #42 y avísame cuando termine."*

**Pregunta por el coste y el historial.** Tus analíticas, en lenguaje natural:
> *"¿Dónde he gastado más en IA esta semana, por proyecto y por modelo? Enséñame los cinco tickets más caros."*

**Tu standup diario.**
> *"Escribe mi standup: qué rails se ejecutaron ayer, qué se completó, qué falló y el coste total — en viñetas listas para pegar en Slack."*

**Entiende el código.** Sin necesidad de editor:
> *"¿Qué archivos tocó el ticket #38? Resume en una línea qué cambió en cada uno."*

Como tu asistente lee primero la guía incorporada, rara vez necesitas nombrar herramientas ni specs — describe el resultado que quieres y él se encarga de las llamadas.

## Algunas cosas que conviene saber

- **Specrails tiene que estar en ejecución.** El servidor MCP vive dentro de la app, así que tu asistente solo puede alcanzarlo mientras Specrails esté abierto. Gracias al icono de la bandeja, cerrar la ventana lo mantiene en ejecución en segundo plano — solo **Salir** desde la bandeja (barra de menú de Mac / bandeja del sistema de Windows) lo detiene de verdad.
- **Las acciones largas se transmiten.** Lanzar un rail o generar una spec devuelve el control de inmediato y termina en segundo plano; tu asistente puede "vigilarlo" e informarte cuando se resuelva.
- **Seguridad.** El MCP usa su propio token de acceso, separado de todo lo demás, y solo escucha en tu propia máquina (loopback). Puedes copiar o regenerar ese token en cualquier momento desde el panel.
- **No expuesto (v1).** Por seguridad, unas pocas capacidades de alto riesgo se dejan fuera a propósito: ejecutar comandos de shell en la terminal, el navegador integrado, la edición de archivos dentro de la app y la instalación de prerrequisitos del sistema. Todo lo que *gestiona* Specrails está disponible; el acceso directo a la máquina, no.

Puedes desactivar MCP en cualquier momento desde el mismo panel — tu asistente simplemente pierde el acceso y nada más cambia.
